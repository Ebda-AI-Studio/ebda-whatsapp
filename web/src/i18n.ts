export type Lang = 'ar' | 'en';

const ar = {
  nav: 'التنقل الرئيسي', inbox: 'المحادثات', templates: 'القوالب', campaigns: 'الحملات', settings: 'الإعدادات',
  conversations: 'المحادثات', all: 'الكل', unread: 'غير مقروءة', mine: 'ليا', unassigned: 'بدون مسؤول',
  search: 'ابحث في المحادثات', noResults: 'مفيش محادثات هنا دلوقتي.', pickChat: 'اختار محادثة من القايمة علشان تبدأ ترد.',
  typeMessage: 'اكتب رسالة', send: 'إرسال', quickReplies: 'ردود سريعة', pickTemplate: 'اختيار قالب', attach: 'إرفاق ملف',
  today: 'النهارده', yesterday: 'أمس', assignedTo: 'مع', unassignedLabel: 'بدون مسؤول',
  customerOrders: 'طلبات العميل', ordersCount: (n: string) => `${n} طلبات`, delivered: (a: string, b: string) => `استلم ${a} من ${b}`,
  confirmOrder: 'تأكيد الطلب', refuseOrder: 'رفض', total: 'الإجمالي', cod: 'الدفع عند الاستلام', link: 'رابط دفع', instapay: 'إنستاباي', card: 'كارت', wallet: 'محفظة',
  items: (n: string) => `${n} منتج`, noOrders: 'العميل ده لسه ما طلبش حاجة.',
  stops: { placed: 'اتطلب', confirmed: 'تأكيد', shipped: 'اتشحن', delivered: 'وصل' },
  orderStatus: { pending_confirmation: 'في انتظار التأكيد', confirmed: 'متأكد', refused: 'مرفوض', shipped: 'اتشحن', delivered: 'وصل', cancelled: 'اتلغى', returned: 'مرتجع' },
  status: { queued: 'بيتبعت', claimed: 'بيتبعت', accepted: 'اتبعت', sent: 'اتبعت', delivered: 'وصلت', read: 'اتقرت', failed: 'ما اتبعتتش', retry: 'هنحاول تاني' },
  retry: 'حاول تاني', sample: 'بيانات تجريبية للعرض فقط', optedOut: 'العميل ده طلب يوقف الرسائل التسويقية.',
  back: 'رجوع للمحادثات', showOrders: 'الطلبات', hideOrders: 'إخفاء الطلبات', close: 'قفل',
  offline: 'الاتصال مقطوع. هنبعت رسايلك أول ما النت يرجع.', loadError: 'مقدرناش نحمّل المحادثات. جرّب تاني.',
  language: 'English', minutesShort: 'د', hoursShort: 'س',
  windowOpen: (h: string) => `النافذة مفتوحة · باقي ${h} ساعة`, windowClosing: (m: string) => `النافذة بتقفل خلال ${m} دقيقة`, windowClosed: 'النافذة مقفولة · ابعت قالب',
  windowClosedHelp: 'عدّى أكتر من ٢٤ ساعة على آخر رسالة من العميل، فواتساب بيسمح بس بقالب معتمد لحد ما يرد.',
  unreadCount: (n: string) => `${n} غير مقروءة`, newActivity: 'فيه جديد',
  imageAlt: 'صورة من المحادثة', loadingMedia: 'الصورة بتحمّل', downloadFile: 'تحميل الملف', mediaUnavailable: 'الملف مش متاح', readMore: 'اقرا الرسالة كلها',
  codPending: 'طلب مستني تأكيد', undo: 'تراجع', confirmedToast: (n: string) => `اتأكد الطلب ${n}`, refusedToast: (n: string) => `اترفض الطلب ${n}`,
  refuseConfirm: 'أيوه، ارفض الطلب', refuseCancel: 'لا، رجوع', refuseAsk: 'متأكد إنك عايز ترفض الطلب ده؟',
  templateVar: (n: number) => `متغير ${num(n, 'ar')}`, sendTemplate: 'ابعت القالب',
  viewOrder: 'عرض الطلب', noChatOrders: 'افتح محادثة علشان تشوف طلبات العميل هنا.', sendFailed: 'ما اتبعتتش',
  templateNames: { cod_confirmation: 'تأكيد الدفع عند الاستلام', shipping_update: 'تحديث الشحن', order_confirmation: 'تأكيد الطلب', otp_code: 'كود التحقق' } as Record<string, string>,
  quickReplyTexts: ['أهلًا بيك! أقدر أساعدك إزاي؟', 'طلبك اتأكد وهيوصلك خلال ٢–٣ أيام.', 'ممكن تبعتلي العنوان بالتفصيل؟', 'شكرًا ليك، في خدمتك في أي وقت.'],
};

const en: typeof ar = {
  nav: 'Main navigation', inbox: 'Inbox', templates: 'Templates', campaigns: 'Campaigns', settings: 'Settings',
  conversations: 'Conversations', all: 'All', unread: 'Unread', mine: 'Mine', unassigned: 'Unassigned',
  search: 'Search conversations', noResults: 'No conversations here right now.', pickChat: 'Pick a conversation from the list to start replying.',
  typeMessage: 'Type a message', send: 'Send', quickReplies: 'Quick replies', pickTemplate: 'Choose a template', attach: 'Attach a file',
  today: 'Today', yesterday: 'Yesterday', assignedTo: 'Assigned to', unassignedLabel: 'Unassigned',
  customerOrders: 'Customer orders', ordersCount: (n) => `${n} orders`, delivered: (a, b) => `Received ${a} of ${b}`,
  confirmOrder: 'Confirm order', refuseOrder: 'Refuse', total: 'Total', cod: 'Cash on delivery', link: 'Payment link', instapay: 'InstaPay', card: 'Card', wallet: 'Wallet',
  items: (n) => `${n} items`, noOrders: 'This customer has not ordered yet.',
  stops: { placed: 'Placed', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered' },
  orderStatus: { pending_confirmation: 'Awaiting confirmation', confirmed: 'Confirmed', refused: 'Refused', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned' },
  status: { queued: 'Sending', claimed: 'Sending', accepted: 'Sent', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not sent', retry: 'Retrying' },
  retry: 'Try again', sample: 'Sample data for preview only', optedOut: 'This customer asked to stop marketing messages.',
  back: 'Back to conversations', showOrders: 'Orders', hideOrders: 'Hide orders', close: 'Close',
  offline: 'You are offline. Your messages will send when the connection is back.', loadError: 'We could not load conversations. Try again.',
  language: 'العربية', minutesShort: 'm', hoursShort: 'h',
  windowOpen: (h) => `Window open · ${h} h left`, windowClosing: (m) => `Window closes in ${m} min`, windowClosed: 'Window closed · send a template',
  windowClosedHelp: 'More than 24 hours have passed since the customer last wrote, so WhatsApp only allows an approved template until they reply.',
  unreadCount: (n) => `${n} unread`, newActivity: 'New activity',
  imageAlt: 'Image from the conversation', loadingMedia: 'Loading image', downloadFile: 'Download file', mediaUnavailable: 'File unavailable', readMore: 'Read the full message',
  codPending: 'Order awaiting confirmation', undo: 'Undo', confirmedToast: (n) => `Order ${n} confirmed`, refusedToast: (n) => `Order ${n} refused`,
  refuseConfirm: 'Yes, refuse the order', refuseCancel: 'No, go back', refuseAsk: 'Refuse this order?',
  templateVar: (n) => `Variable ${n}`, sendTemplate: 'Send template',
  viewOrder: 'View order', noChatOrders: 'Open a conversation to see the customer\'s orders here.', sendFailed: 'Not sent',
  templateNames: { cod_confirmation: 'COD confirmation', shipping_update: 'Shipping update', order_confirmation: 'Order confirmation', otp_code: 'Verification code' },
  quickReplyTexts: ['Hi! How can I help?', 'Your order is confirmed and arrives in 2–3 days.', 'Could you send your full address?', 'Thank you, we are here anytime.'],
};

export const STRINGS = { ar, en };
export type Strings = typeof ar;

export function num(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', { useGrouping: lang !== 'ar' || n >= 10000 }).format(n);
}
