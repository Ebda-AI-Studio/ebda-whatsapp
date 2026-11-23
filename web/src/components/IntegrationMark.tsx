/** A mark for an integration. Odoo shows its official logo (odoo.com/page/brand-assets, unaltered, on a light tile, min height 20px; see web/brands/ebda/public/brand/SOURCES.md). The webhook keeps its generic { } mark; any other kind a two-letter wordmark tile. */
export function IntegrationMark({ kind }: { kind: 'webhook' | 'odoo' | string }) {
  if (kind === 'odoo') return <span className="int-mark" data-kind="odoo" dir="ltr"><img src="/brand/odoo-logo.svg" alt="Odoo logo" width="40" height="22" /></span>;
  return <span className="int-mark" data-kind={kind} aria-hidden dir="ltr">{kind === 'webhook' ? '{ }' : kind.slice(0, 2)}</span>;
}
