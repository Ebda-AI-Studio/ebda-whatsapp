/** A wordmark tile for an integration: the first letters on the Ebda night/gold ground. No third-party brand logo is drawn or imitated here; a real, licensed logo can replace the tile by id later. */
export function IntegrationMark({ kind }: { kind: 'webhook' | 'odoo' | string }) {
  const word = kind === 'odoo' ? 'Odoo' : kind;
  return <span className="int-mark" data-kind={kind} aria-hidden dir="ltr">{kind === 'webhook' ? '{ }' : word.slice(0, 2)}</span>;
}
