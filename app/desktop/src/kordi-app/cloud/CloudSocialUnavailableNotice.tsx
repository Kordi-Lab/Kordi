export function CloudSocialUnavailableNotice({ className }: { className: string }) {
  return (
    <p data-cloud-social-sign-in-unavailable="true" className={className}>
      Google and GitHub sign-in aren’t available on this server. Use email and password.
    </p>
  );
}
