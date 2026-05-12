# Multi-stage build for kordi-cloud-temporal-bridge.
# Stage 1: build the binary against pinned go.mod / go.sum.
# Stage 2: copy the static binary into a distroless image.
#
# Build context is the bridges/cloud-temporal-bridge/ directory.

FROM golang:1.22-alpine AS build

WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY *.go ./
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
RUN go build -o /out/kordi-cloud-temporal-bridge -ldflags="-s -w" .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/kordi-cloud-temporal-bridge /usr/local/bin/kordi-cloud-temporal-bridge
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/kordi-cloud-temporal-bridge"]
