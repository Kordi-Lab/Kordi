// kordi-cloud-temporal-bridge bridges NATS lifecycle events into
// durable Temporal workflows.
//
// Today it handles one workflow: SignupVerification, kicked off when a
// user signs up. The cloud-server publishes
//
//	kordi.events.account.signed_up.<account_id>
//
// with a small JSON envelope; this binary subscribes to that subject,
// starts a workflow keyed by account_id (so duplicate publishes don't
// fan out), and runs the worker that ultimately sends the verification
// email via SMTP. Mailpit is the dev-time SMTP sink.
//
// Why a separate binary (not embedded in cloud-server)?
// - Temporal's Rust SDK is alpha; the Go SDK is mature.
// - Workers scale independently from the API. When agent-execution
//   workers arrive (session 10 of the architecture rollout), they'll
//   be more workers in this same fleet.
// - Cloud-server stays HTTP-only; this is its companion.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/smtp"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

const (
	// Task queue the bridge worker polls. Activities + workflows are
	// dispatched here.
	taskQueue = "kordi-cloud-verification"

	// Subject pattern the bridge listens on. The trailing wildcard
	// captures the account_id so we can read it back without parsing
	// the payload twice.
	natsSubject = "kordi.events.account.signed_up.>"
)

// SignupEvent is the JSON envelope published by the cloud-server.
// Keep in lockstep with bridges/cloud-server/src/events/mod.rs.
type SignupEvent struct {
	EventType    string `json:"event_type"`
	AccountID    string `json:"account_id"`
	PrimaryEmail string `json:"primary_email"`
	OccurredAt   string `json:"occurred_at"`
}

// SendVerificationEmailInput is the activity input. Decoupled from the
// NATS envelope so the workflow definition is stable across producer
// changes.
type SendVerificationEmailInput struct {
	AccountID    string
	PrimaryEmail string
	Token        string
}

// SignupVerificationWorkflow runs once per signup. It generates a
// verification token, hands it to the email-sending activity, then
// completes. The activity is retried on transient errors per Temporal's
// default retry policy (we tighten the schedule below).
func SignupVerificationWorkflow(ctx workflow.Context, ev SignupEvent) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("SignupVerificationWorkflow starting", "account", ev.AccountID, "email", ev.PrimaryEmail)

	// Workflow-deterministic token. Using SideEffect so the value is
	// recorded in history — replays return the same token.
	var token string
	encoded := workflow.SideEffect(ctx, func(ctx workflow.Context) interface{} {
		// 64-bit hex from the workflow's deterministic clock — good
		// enough for a verification handle in dev. A production
		// version would bind to a server-issued opaque token stored
		// in Postgres.
		t := workflow.Now(ctx).UnixNano()
		return strconv.FormatInt(t, 16)
	})
	if err := encoded.Get(&token); err != nil {
		return fmt.Errorf("derive verification token: %w", err)
	}

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    30 * time.Second,
			MaximumAttempts:    5,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	if err := workflow.ExecuteActivity(ctx, SendVerificationEmailActivity, SendVerificationEmailInput{
		AccountID:    ev.AccountID,
		PrimaryEmail: ev.PrimaryEmail,
		Token:        token,
	}).Get(ctx, nil); err != nil {
		return fmt.Errorf("send verification email: %w", err)
	}

	logger.Info("SignupVerificationWorkflow complete", "account", ev.AccountID)
	return nil
}

// SendVerificationEmailActivity sends the actual SMTP message. SMTP
// failures are surfaced as activity errors so Temporal retries with
// the workflow's retry policy.
func SendVerificationEmailActivity(ctx context.Context, input SendVerificationEmailInput) error {
	smtpHost := envOr("SMTP_HOST", "mailpit.kordi-cloud.svc.cluster.local")
	smtpPort := envOr("SMTP_PORT", "1025")
	from := envOr("SMTP_FROM", "no-reply@kordi.cloud")

	addr := fmt.Sprintf("%s:%s", smtpHost, smtpPort)
	subject := "Verify your Kordi account"
	body := fmt.Sprintf(`Welcome to Kordi.

Click the link below to verify your account:

  https://kordi.cloud/verify?account=%s&token=%s

If you didn't sign up for Kordi, ignore this email.
`, input.AccountID, input.Token)
	msg := strings.Join([]string{
		"From: " + from,
		"To: " + input.PrimaryEmail,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"X-Kordi-Account-Id: " + input.AccountID,
		"X-Kordi-Verification-Token: " + input.Token,
		"",
		body,
	}, "\r\n")

	// Mailpit doesn't require auth on the SMTP listener.
	if err := smtp.SendMail(addr, nil, from, []string{input.PrimaryEmail}, []byte(msg)); err != nil {
		return fmt.Errorf("smtp send to %s: %w", addr, err)
	}
	return nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	temporalAddr := envOr("TEMPORAL_ADDRESS", "temporal.kordi-cloud.svc.cluster.local:7233")
	temporalNS := envOr("TEMPORAL_NAMESPACE", "kordi")
	natsURL := envOr("NATS_URL", "nats://nats.kordi-cloud.svc.cluster.local:4222")

	log.Printf("connecting to Temporal at %s (namespace=%s)", temporalAddr, temporalNS)
	tc, err := dialTemporalWithRetry(temporalAddr, temporalNS, 60*time.Second)
	if err != nil {
		log.Fatalf("temporal client: %v", err)
	}
	defer tc.Close()

	w := worker.New(tc, taskQueue, worker.Options{})
	w.RegisterWorkflow(SignupVerificationWorkflow)
	w.RegisterActivity(SendVerificationEmailActivity)
	if err := w.Start(); err != nil {
		log.Fatalf("worker start: %v", err)
	}
	defer w.Stop()
	log.Printf("worker listening on task queue %q", taskQueue)

	log.Printf("connecting to NATS at %s", natsURL)
	nc, err := nats.Connect(natsURL,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
		nats.Timeout(10*time.Second),
	)
	if err != nil {
		log.Fatalf("nats connect: %v", err)
	}
	defer nc.Drain()

	sub, err := nc.Subscribe(natsSubject, func(m *nats.Msg) {
		var ev SignupEvent
		if err := json.Unmarshal(m.Data, &ev); err != nil {
			log.Printf("[bridge] decode envelope: %v (subject=%s)", err, m.Subject)
			return
		}
		if ev.AccountID == "" || ev.PrimaryEmail == "" {
			log.Printf("[bridge] skip envelope without account/email: %s", m.Subject)
			return
		}
		// One workflow per account. WorkflowIDReusePolicy_REJECT_DUPLICATE
		// (the default) makes the second start error out, which is
		// exactly what we want for an at-least-once NATS feed.
		opts := client.StartWorkflowOptions{
			ID:        "signup-verification:" + ev.AccountID,
			TaskQueue: taskQueue,
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		run, err := tc.ExecuteWorkflow(ctx, opts, SignupVerificationWorkflow, ev)
		if err != nil {
			log.Printf("[bridge] start workflow for %s: %v", ev.AccountID, err)
			return
		}
		log.Printf("[bridge] started workflow run=%s wf=%s account=%s",
			run.GetRunID(), run.GetID(), ev.AccountID)
	})
	if err != nil {
		log.Fatalf("nats subscribe: %v", err)
	}
	defer sub.Unsubscribe()
	log.Printf("subscribed to %s", natsSubject)

	// Park the main goroutine until SIGINT/SIGTERM.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	<-sigs
	log.Printf("shutdown signal received")
}

func dialTemporalWithRetry(addr, ns string, total time.Duration) (client.Client, error) {
	deadline := time.Now().Add(total)
	for {
		c, err := client.Dial(client.Options{
			HostPort:  addr,
			Namespace: ns,
		})
		if err == nil {
			return c, nil
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		log.Printf("temporal not ready yet (%v); retrying...", err)
		time.Sleep(2 * time.Second)
	}
}
