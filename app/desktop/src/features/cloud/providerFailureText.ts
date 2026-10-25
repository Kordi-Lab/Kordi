const PROVIDER_RESPONSE_MARKER = ' Provider response: ';

/**
 * A failed run on this Mac adds the provider's own text for its owner. A
 * reply other people read keeps only the fixed wording before it.
 */
export function withoutProviderResponse<Text extends string | null | undefined>(text: Text): Text {
  const index = text ? text.indexOf(PROVIDER_RESPONSE_MARKER) : -1;
  return (index > 0 ? text!.slice(0, index) : text) as Text;
}
