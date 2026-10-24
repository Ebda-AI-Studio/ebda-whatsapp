import { X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { OrderSummaryDto } from '../../../src/core/api/contract';
import { num, type Lang, type Strings } from '../i18n';
import { formatMoney, orderStops } from '../lib/format';

type Props = {
  t: Strings; lang: Lang; orders: OrderSummaryDto[] | null;
  onConfirm: (o: OrderSummaryDto) => void; onRefuse: (o: OrderSummaryDto) => void; onClose: () => void;
};

export function OrderRail({ t, status }: { t: Strings; status: OrderSummaryDto['status'] }) {
  const stops = orderStops(status);
  const reached = stops.filter((s) => s.done).length - 1;
  const style = { '--fill': `${(Math.max(reached, 0) / 3) * 75}%` } as CSSProperties;
  return (
    <ol className="rail-stops" style={style} aria-label={t.orderStatus[status]}>
      <span className="fill" aria-hidden />
      {stops.map((s) => (
        <li key={s.key} data-done={s.done} data-halted={s.halted ?? false} aria-current={s.done && stops.indexOf(s) === reached ? 'step' : undefined}>
          <span className="dot" aria-hidden />
          {s.halted ? t.orderStatus[status] : t.stops[s.key]}
        </li>
      ))}
    </ol>
  );
}

export function OrderPane({ t, lang, orders, onConfirm, onRefuse, onClose }: Props) {
  const [current, ...older] = orders ?? [];
  const delivered = (orders ?? []).filter((o) => o.status === 'delivered').length;
  const finished = (orders ?? []).filter((o) => ['delivered', 'refused', 'returned', 'cancelled'].includes(o.status)).length;
  return (
    <aside className="orders" aria-label={t.customerOrders}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2>{t.customerOrders}</h2>
          {orders && orders.length > 0 && <div className="muted">{t.ordersCount(num(orders.length, lang))} · {t.delivered(num(delivered, lang), num(finished, lang))}</div>}
        </div>
        <button type="button" className="icon-btn orders-toggle" onClick={onClose} aria-label={t.close}><X size={18} aria-hidden /></button>
      </div>
      {orders && orders.length === 0 && <p className="muted">{t.noOrders}</p>}
      {current && (
        <article className="order-card" aria-label={current.orderNumber}>
          <div className="order-top"><b>{current.orderNumber}</b><span className="order-total">{formatMoney(current.totalMinor, current.currency, lang)}</span></div>
          <div className="muted">{t.items(num(current.itemsCount, lang))} · {t[current.paymentMethod]}</div>
          <span className="status" data-status={current.status}>{t.orderStatus[current.status]}</span>
          <OrderRail t={t} status={current.status} />
          {current.status === 'pending_confirmation' && (
            <div className="order-actions">
              <button type="button" className="btn gold" onClick={() => onConfirm(current)}>{t.confirmOrder}</button>
              <button type="button" className="btn" onClick={() => onRefuse(current)}>{t.refuseOrder}</button>
            </div>
          )}
        </article>
      )}
      {older.map((o) => (
        <div key={o.orderNumber + o.at} className="order-row">
          <span>{o.orderNumber} · <span className="status" data-status={o.status}>{t.orderStatus[o.status]}</span></span>
          <span className="muted">{formatMoney(o.totalMinor, o.currency, lang)}</span>
        </div>
      ))}
    </aside>
  );
}
