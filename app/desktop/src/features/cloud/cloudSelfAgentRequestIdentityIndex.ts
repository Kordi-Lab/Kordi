export class CloudSelfAgentRequestIdentityIndex {
  readonly #byCloudMessageId = new Map<string, string>();
  readonly #byCanonicalMessageId = new Map<string, string>();

  getByCloudMessageId(messageId: string) {
    return this.#byCloudMessageId.get(messageId);
  }

  getByCanonicalMessageId(messageId: string) {
    return this.#byCanonicalMessageId.get(messageId);
  }

  remember(
    cloudMessageId: string,
    canonicalMessageId: string,
    cloudIdentity = cloudMessageId,
  ) {
    this.#byCloudMessageId.set(cloudMessageId, cloudIdentity);
    this.#byCanonicalMessageId.set(canonicalMessageId, cloudIdentity);
  }

  rememberCloudAlias(cloudMessageId: string, cloudIdentity: string) {
    this.#byCloudMessageId.set(cloudMessageId, cloudIdentity);
  }
}
