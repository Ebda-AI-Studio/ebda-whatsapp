import { X } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import type { OrderSummaryDto } from '../../../src/core/api/contract';
import { num, type Lang, type Strings } from '../i18n';
import { formatMoney, orderStops } from '../lib/format';

type Props = {
  t: Strings; lang: Lang; orders: OrderSummaryDto[] | null; hasChat: boolean; canDecide: boolean;
  onConfirm: (o: OrderSummaryDto) => void; onRefuse: (o: OrderSummaryDto) => void; onClose: () => void;
};

export function OrderRail({ t, status }: { t: Strings; status: OrderSummaryDto['status'] }) {
  const stops = orderStops(status);
  const reached = stops.filter((s) => s.done).length - 1;
  const style = { '--fill': `${(Math.max(reached, 0) / 3) * 75}%` } as CSSProperties;
  return (
    <ol className="rail-stops" style={style} aria-label={t.orderStatus[status]}>
      {stops.map((s, i) => (
        <li key={s.key} data-done={s.done} data-halted={s.halted ?? false} aria-current={s.done && i === reached ? 'step' : undefined}>
          <span className="dot" aria-hidden />
          {s.halted ? t.orderStatus[status] : t.stops[s.key]}
        </li>
      ))}
    </ol>
  );
}

export function OrderPane({ t, lang, orders, hasChat, canDecide, onConfirm, onRefuse, onClose }: Props) {
  const [askingRefuse, setAskingRefuse] = useState(false);
  const [current, ...older] = orders ?? [];
  const delivered = (orders ?? []).filter((o) => o.status === 'delivered').length;
  const finished = (orders ?? []).filter((o) => ['delivered', 'refused', 'returned', 'cancelled'].includes(o.status)).length;
  return (
    <aside className="orders" aria-label={t.customerOrders}>
      <div className="orders-head">
        <div>
          <h2>{t.customerOrders}</h2>
          {orders && orders.length > 0 && <div className="muted">{t.ordersCount(num(orders.length, lang))} · {t.delivered(num(delivered, lang), num(finished, lang))}</div>}
        </div>
        <button type="button" className="icon-btn orders-toggle" onClick={onClose} aria-label={t.close}><X size={18} aria-hidden /></button>
      </div>
      {!hasChat && <p className="muted">{t.noChatOrders}</p>}
      {hasChat && orders && orders.length === 0 && <p className="muted">{t.noOrders}</p>}
      {current && (
        <article className="order-card" aria-label={current.orderNumber}>
          <div className="order-top"><b><bdi>{current.orderNumber}</bdi></b><span className="order-total">{formatMoney(current.totalMinor, current.currency, lang)}</span></div>
          <div className="muted">{t.items(num(current.itemsCount, lang))} · {t[current.paymentMethod as 'cod'] ?? current.paymentMethod}</div>
          <span className="status" data-status={current.status}>{t.orderStatus[current.status]}</span>
          <OrderRail t={t} status={current.status} />
          {canDecide && current.status === 'pending_confirmation' && !askingRefuse && (
            <div className="order-actions">
              <button type="button" className="btn gold" onClick={() => onConfirm(current)}>{t.confirmOrder}</button>
              <button type="button" className="btn" onClick={() => setAskingRefuse(true)}>{t.refuseOrder}</button>
            </div>
          )}
          {canDecide && current.status === 'pending_confirmation' && askingRefuse && (
            <div className="refuse-ask" role="group" aria-label={t.refuseAsk}>
              <span>{t.refuseAsk}</span>
              <div className="order-actions">
                <button type="button" className="btn danger" onClick={() => { setAskingRefuse(false); onRefuse(current); }}>{t.refuseConfirm}</button>
                <button type="button" className="btn" onClick={() => setAskingRefuse(false)}>{t.refuseCancel}</button>
              </div>
            </div>
          )}
        </article>
      )}
      {older.map((o) => (
        <div key={o.orderNumber + o.at} className="order-row">
          <span><bdi>{o.orderNumber}</bdi> · <span className="status" data-status={o.status}>{t.orderStatus[o.status]}</span></span>
          <span className="muted">{formatMoney(o.totalMinor, o.currency, lang)}</span>
        </div>
      ))}
    </aside>
  );
}
