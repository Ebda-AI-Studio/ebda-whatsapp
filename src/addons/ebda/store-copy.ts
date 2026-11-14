import type { Locale, Localised, OrderingCopy } from '../../core/ordering/copy';
import { plainAmount } from '../../core/ordering/money';

const L = (ar: string, en: string): Localised => ({ ar, en });

const STATUS_NAMES: Record<string, Localised> = {
  pending_confirmation: L('مستني التأكيد', 'awaiting confirmation'),
  pending_payment: L('مستني الدفع', 'awaiting payment'),
  confirmed: L('اتأكد', 'confirmed'),
  refused: L('اتلغى', 'cancelled'),
  shipped: L('اتشحن', 'shipped'),
  delivered: L('اتسلّم', 'delivered'),
  cancelled: L('اتلغى', 'cancelled'),
  returned: L('اتّرجع', 'returned'),
};

const SHIPMENT: Record<string, Localised> = {
  shipped: L('خرج للشحن 🚚', 'has shipped 🚚'),
  in_transit: L('في الطريق ليك 🚚', 'is on its way 🚚'),
  out_for_delivery: L('مع المندوب وهيوصلك النهاردة', 'is out for delivery today'),
  delivered: L('اتسلّم ✅', 'was delivered ✅'),
  failed_delivery: L('المندوب مقدرش يوصلك، هنتواصل معاك', 'could not be delivered, we will contact you'),
};

/** Ebda Chat's customer-facing words: Egyptian Arabic in full sentences, English alongside. The core receives this through configureStoreLink. */
export const EBDA_ORDERING_COPY: OrderingCopy = {
  templates: {
    orderConfirmation: 'order_confirmation',
    codConfirmation: 'cod_confirmation',
    shippingTracking: 'shipping_tracking',
    shippingStatus: 'shipping_status',
    cartRecovery: 'cart_recovery',
    otp: 'otp_code',
  },
  restartWords: ['طلب جديد', 'ابدأ من جديد', 'new order', 'start over', 'menu', 'القائمة'],
  languageWords: { ar: ['عربي', 'arabic'], en: ['english', 'انجليزي'] },
  ordersWords: ['طلباتي', 'طلبي', 'my orders', 'where is my order', 'orders'],
  codConfirmTitles: ['أيوه، أكّد الطلب'],
  codRefuseTitles: ['إلغاء الطلب'],
  customerName: L('عميلنا العزيز', 'there'),
  menu: {
    menuWords: ['menu', 'القائمة', 'القايمة'],
    greetingWords: ['hi', 'hello', 'hey', 'good morning', 'good evening', 'السلام عليكم', 'سلام', 'اهلا', 'أهلاً', 'مرحبا', 'هلا', 'صباح الخير', 'مساء الخير'],
    locationWords: ['location', 'address', 'where are you', 'العنوان', 'فين', 'مكانكم', 'موقعكم', 'لوكيشن'],
    body: L('أهلاً بيك 👋 اختار من القايمة اللي محتاج تعرفه، أو اطلب مباشرة من هنا.', 'Welcome 👋 Pick what you would like to know from the list, or order right here.'),
    button: L('القايمة', 'Menu'),
    orderRow: L('اطلب دلوقتي', 'Order now'),
    locationRow: L('عنواننا', 'Our location'),
    humanRow: L('كلّم حد مننا', 'Talk to a person'),
    handedOff: L('تمام، حد من فريقنا هيرد عليك هنا في أقرب وقت.', 'Okay, someone from our team will reply to you here shortly.'),
  },
  money: (minor, currency, locale) => (currency === 'EGP' ? (locale === 'ar' ? `${plainAmount(minor)} جنيه` : `EGP ${plainAmount(minor)}`) : `${plainAmount(minor)} ${currency}`),
  shipmentPhrase: (status, locale) => SHIPMENT[status]?.[locale] ?? null,
  t: {
    greeting: (storeName, locale) => (locale === 'ar'
      ? `أهلاً بيك في ${storeName} 👋\nاختار اللي يعجبك من القايمة، وأنا هجهّزلك الطلب هنا في الشات.`
      : `Welcome to ${storeName} 👋\nPick what you like from the list and I will set up your order right here in the chat.`),
    browseBody: L('اختار منتج من القايمة دي', 'Pick a product from this list'),
    browseButton: L('المنتجات', 'Products'),
    moreRow: L('شوف المزيد', 'Show more'),
    outOfStockTag: L('خلص', 'sold out'),
    emptyCatalog: L('مفيش منتجات متاحة دلوقتي. جرّب تاني بعد شوية.', 'No products are available right now. Please try again in a bit.'),
    storeUnavailable: L('حصلت مشكلة صغيرة عندنا. جرّب تاني كمان شوية.', 'Something went wrong on our side. Please try again shortly.'),
    askQuantity: (title, locale) => (locale === 'ar' ? `هتاخد كام قطعة من "${title}"؟ اختار من الأزرار أو اكتب الرقم.` : `How many of "${title}" would you like? Tap a button or type a number.`),
    cartSummary: (lines, subtotal, locale) => {
      const rows = lines.map((l) => `• ${l.quantity} × ${l.title}`).join('\n');
      return locale === 'ar' ? `سلتك:\n${rows}\nالإجمالي: ${subtotal}` : `Your cart:\n${rows}\nSubtotal: ${subtotal}`;
    },
    cartButtons: { checkout: L('كمّل الطلب', 'Checkout'), addMore: L('أضف منتج', 'Add more'), clear: L('امسح السلة', 'Clear cart') },
    cartEmpty: L('سلتك فاضية. اختار منتج الأول.', 'Your cart is empty. Pick a product first.'),
    choosePayment: L('تحب تدفع إزاي؟', 'How would you like to pay?'),
    paymentTitles: { cod: L('الدفع عند الاستلام', 'Cash on delivery'), link: L('دفع أونلاين', 'Pay online'), instapay: L('إنستاباي', 'InstaPay') },
    chooseAddress: L('التوصيل على أنهي عنوان؟', 'Which address should we deliver to?'),
    addressesButton: L('العناوين', 'Addresses'),
    newAddressRow: L('+ عنوان جديد', '+ New address'),
    askAddress: L('ابعتلي عنوان التوصيل: المنطقة الأول، وبعدين الشارع والعمارة. مثلاً: المعادي، شارع 9 عمارة 4.', 'Send your delivery address: the area first, then the street and building. For example: Maadi, Street 9 building 4.'),
    outOfStock: (names, locale) => (locale === 'ar'
      ? `للأسف ${names.join('، ')} خلصوا من المخزون، وشيلتهم من السلة. شوف باقي الطلب.`
      : `Sorry, ${names.join(', ')} just ran out of stock, so I removed them from your cart. Have a look at the rest.`),
    codPlaced: (n, total, locale) => (locale === 'ar'
      ? `تمام ✅ طلبك رقم ${n} اتسجّل${total ? ` بإجمالي ${total}` : ''} والدفع عند الاستلام. هنكلمك لو احتجنا حاجة.`
      : `Done ✅ your order ${n} is placed${total ? ` for ${total}` : ''}, pay on delivery. We will reach out if we need anything.`),
    linkPlaced: (n, url, locale) => (locale === 'ar' ? `طلبك رقم ${n} جاهز للدفع 💳\nادفع من هنا: ${url}` : `Your order ${n} is ready for payment 💳\nPay here: ${url}`),
    instapayPlaced: (n, ipa, amount, ref, locale) => (locale === 'ar'
      ? `طلبك رقم ${n} اتسجّل ✅\nحوّل ${amount} على إنستاباي:\nالعنوان: ${ipa}\nالمرجع (اكتبه في الملاحظات): ${ref}\nبعد التحويل ابعتلي صورة الإيصال هنا، وهنأكد طلبك أول ما نتأكد من الدفع.`
      : `Your order ${n} is placed ✅\nPlease transfer ${amount} via InstaPay:\nAddress: ${ipa}\nReference (put it in the notes): ${ref}\nThen send me the receipt screenshot here and we will confirm your order once the payment is verified.`),
    awaitingReceipt: L('لسه مستنيين صورة إيصال التحويل. ابعتها هنا، أو ابعت "طلب جديد" لو عايز تبدأ من الأول.', 'We are still waiting for your transfer receipt. Send it here, or send "new order" to start over.'),
    proofReceived: L('وصلنا إيصال التحويل ✅ هنراجعه ونأكد طلبك.', 'We got your transfer receipt ✅ We will check it and confirm your order.'),
    proofAlready: L('استلمنا الإيصال قبل كده وهو تحت المراجعة. هنبلغك أول ما يتأكد.', 'We already have your receipt and it is being checked. We will tell you as soon as it is confirmed.'),
    proofExpired: L('مدة إرسال الإيصال خلصت. ابعتلنا "طلب جديد" لو لسه عايز تكمّل.', 'The time to send the receipt has passed. Send "new order" if you still want to order.'),
    paymentConfirmed: (n, locale) => (locale === 'ar' ? `تم تأكيد الدفع لطلبك رقم ${n} ✅ شكراً ليك!` : `Payment confirmed for your order ${n} ✅ Thank you!`),
    orderFailed: L('معرفناش نكمّل الطلب دلوقتي. جرّب تاني بعد شوية.', 'We could not complete the order right now. Please try again shortly.'),
    useButtons: L('اختار من الأزرار اللي فوق 👆', 'Please pick from the buttons above 👆'),
    codConfirmed: L('تمام، طلبك اتأكد ✅ شكراً ليك!', 'Great, your order is confirmed ✅ Thank you!'),
    codRefused: L('تمام، الغينا الطلب. لو غيّرت رأيك ابعتلنا "طلب جديد".', 'Okay, we cancelled the order. If you change your mind, send "new order".'),
    ordersHeader: L('آخر طلباتك:', 'Your latest orders:'),
    orderLine: (n, status, locale) => (locale === 'ar' ? `• رقم ${n}: ${status}` : `• Order ${n}: ${status}`),
    noOrders: L('مفيش طلبات سابقة على رقمك.', 'There are no earlier orders on your number.'),
    orderStatusNames: STATUS_NAMES,
    cards: {
      single: (title, price, locale) => (locale === 'ar' ? `${title}\nالسعر: ${price}\nاضغط على المنتج وضيفه للسلة، وبعدين ابعتلي السلة وأنا أكمّل معاك الطلب.` : `${title}\nPrice: ${price}\nTap the product, add it to your cart, then send me the cart and I will finish the order with you.`),
      listHeader: L('اخترنالك دول', 'Picked for you'),
      listBody: L('دي المنتجات اللي ليها علاقة بسؤالك. اختار اللي يعجبك وضيفه للسلة، وبعدين ابعتلي السلة وأنا أكمّل الطلب معاك.', 'These are the products that match your question. Pick what you like, add it to your cart, then send me the cart and I will finish the order with you.'),
      listSection: L('المنتجات', 'Products'),
      moreSection: L('منتجات تانية', 'More products'),
      catalogBody: L('دي كل منتجاتنا. افتح الكتالوج، ضيف اللي عايزه للسلة وابعتهالي، وأنا أكمّل الطلب معاك هنا.', 'Here is everything we sell. Open the catalogue, add what you want to your cart and send it to me, and I will finish the order with you here.'),
      catalogFooter: L('الأسعار والمخزون لحظي', 'Live prices and stock'),
      cartUnknown: (names, locale) => (locale === 'ar'
        ? `للأسف ${names.join('، ')} مبقاش متاح عندنا، وشيلته من السلة. شوف باقي الطلب.`
        : `Sorry, ${names.join(', ')} is no longer available, so I took it out of your cart. Have a look at the rest.`),
      cartRepriced: L('الأسعار اتحدثت حسب أسعار المتجر دلوقتي، والإجمالي تحت هو الصح.', 'Prices were updated to the store\'s current prices, so the total below is the right one.'),
      cartOtherCatalogue: L('السلة دي جاية من كتالوج تاني مش بتاعنا، فمقدرتش أقرأها. افتح الكتالوج بتاعنا وضيف منه.', 'This cart came from a different catalogue than ours, so I could not read it. Open our catalogue and add from there.'),
      cartAllGone: L('للأسف المنتجات اللي في السلة مبقتش متاحة. افتح الكتالوج واختار من الجديد.', 'Sorry, the products in your cart are no longer available. Open the catalogue and pick again.'),
    },
  },
};

export type { Locale };
