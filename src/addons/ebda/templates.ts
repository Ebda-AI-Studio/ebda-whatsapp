import type { TemplateSeed } from '../../routes/templates';

/**
 * The richer COD confirmation (v2): store name header, address, item count, total and a button to the order page, plus the
 * same two quick replies as v1 (same titles, so reply matching in store-copy.ts is unchanged). A Meta URL button has a FIXED
 * base and every store has its own storefront domain, so this is a builder, not a starter entry: it is submitted per workspace
 * with that store's origin (cod-v2.ts, on `store.linked` and from the Templates screen). The button opens the Store's guest-safe
 * order summary (`/o/<signed token>`). The sender only uses it when its approved URL base matches the order link the Store sent.
 */
export const COD_V2_NAME = 'cod_confirmation_v2';
export function codConfirmationV2Seed(storefrontOrigin: string): TemplateSeed {
  const base = `${storefrontOrigin.replace(/\/+$/, '')}/o/`;
  return {
    name: COD_V2_NAME,
    language: 'ar',
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'TEXT', text: '{{1}}', example: { header_text: ['متجر النور'] } },
      {
        type: 'BODY',
        text: 'أهلاً {{1}} 👋\nطلبك رقم {{2}} محتاج تأكيدك قبل ما يتشحن.\n\nعنوان التوصيل: {{3}}\nعدد القطع: {{4}}\nإجمالي الطلب: {{5}} جنيه (شامل أي مبلغ اتدفع قبل كده).\n\nراجع تفاصيل الطلب وبعدين اضغط تأكيد أو إلغاء.',
        example: { body_text: [['أحمد', '1001', '9 شارع النصر، المعادي، القاهرة', '3', '750']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'تفاصيل الطلب', url: `${base}{{1}}`, example: [`${base}11111111-1111-4111-8111-111111111111.33333333-3333-4333-8333-333333333333.1795000000.abc`] },
          { type: 'QUICK_REPLY', text: 'أيوه، أكّد الطلب' },
          { type: 'QUICK_REPLY', text: 'إلغاء الطلب' },
        ],
      },
    ],
  };
}

/** Ebda Chat's starter templates (Egyptian Arabic). Submitted to Meta on request; Meta approves them, we never assume it. */
export const EBDA_DEFAULT_TEMPLATES: readonly TemplateSeed[] = [
  {
    name: 'order_confirmation',
    language: 'ar',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'أهلاً {{1}} 👋\nطلبك رقم {{2}} اتسجّل عندنا، وهنبلغك أول ما يتشحن.', example: { body_text: [['أحمد', '1001']] } }],
  },
  {
    name: 'cod_confirmation',
    language: 'ar',
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'أهلاً {{1}}، طلبك رقم {{2}} بإجمالي {{3}} جنيه والدفع عند الاستلام. تأكّد الطلب؟', example: { body_text: [['أحمد', '1001', '750']] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'أيوه، أكّد الطلب' }, { type: 'QUICK_REPLY', text: 'إلغاء الطلب' }] },
    ],
  },
  {
    name: 'shipping_update',
    language: 'ar',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'أهلاً {{1}}، طلبك رقم {{2}} خرج للشحن 🚚 وهيوصلك خلال {{3}}.', example: { body_text: [['أحمد', '1001', 'يومين']] } }],
  },
  {
    name: 'otp_code',
    language: 'ar',
    category: 'AUTHENTICATION',
    components: [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 10 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'نسخ الكود' }] },
    ],
  },
  {
    name: 'cart_recovery',
    language: 'ar',
    category: 'MARKETING',
    components: [{ type: 'BODY', text: 'أهلاً {{1}} 👋 لسه عندك حاجات في السلة مستنياك. كمّل طلبك من هنا: {{2}}', example: { body_text: [['أحمد', 'https://shop.example/cart/abc']] } }],
  },
  {
    name: 'shipping_tracking',
    language: 'ar',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'أهلاً {{1}}، طلبك رقم {{2}} {{3}}. تابع شحنتك من هنا: {{4}}', example: { body_text: [['أحمد', '1001', 'خرج للشحن', 'https://shop.example/track/abc']] } }],
  },
  // Tells the OWNER that a customer needs a person (Ruling CHAT-AGENT-4). Sent only when the owner's own 24 h window is closed.
  {
    name: 'handoff_alert',
    language: 'ar',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'تنبيه من المساعد 🔔 العميل {{1}} محتاج حد من الفريق يرد عليه. التفاصيل: {{2}}', example: { body_text: [['منى', 'عايز اكلم حد']] } }],
  },
  {
    name: 'handoff_alert',
    language: 'en',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Assistant alert 🔔 customer {{1}} needs a team member to reply. Details: {{2}}', example: { body_text: [['Mona', 'I want to speak to someone']] } }],
  },
  {
    name: 'shipping_status',
    language: 'ar',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'أهلاً {{1}}، طلبك رقم {{2}} {{3}}.', example: { body_text: [['أحمد', '1001', 'اتسلّم']] } }],
  },
];
