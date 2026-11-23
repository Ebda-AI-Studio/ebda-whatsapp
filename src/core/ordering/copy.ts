/**
 * Customer-facing words for the Store link: template names, the ordering bot and the order messages.
 * The product supplies an instance (see configureStoreLink); the core only knows the shape.
 */
export type Locale = 'ar' | 'en';
export type Localised = Record<Locale, string>;

export type OrderingCopy = {
  templates: {
    orderConfirmation: string;
    codConfirmation: string;
    /** Richer COD template (header, address, items, order link). Optional: used only when approved and the Store sent every field. */
    codConfirmationV2?: string;
    shippingTracking: string;
    shippingStatus: string;
    cartRecovery: string;
    otp: string;
  };
  /** Words that restart the flow from any state, matched against the whole normalised message. */
  restartWords: readonly string[];
  /** Words that switch language. */
  languageWords: Readonly<Record<Locale, readonly string[]>>;
  ordersWords: readonly string[];
  /** Quick-reply button titles of the COD template, used when a reply carries no payload. */
  codConfirmTitles: readonly string[];
  codRefuseTitles: readonly string[];
  customerName: Localised;
  /** The service menu (see core/front-desk): the words that open it and its fixed rows. Row titles are at most 24 characters, the button 20. */
  menu: {
    menuWords: readonly string[];
    greetingWords: readonly string[];
    locationWords: readonly string[];
    body: Localised;
    button: Localised;
    orderRow: Localised;
    locationRow: Localised;
    humanRow: Localised;
    handedOff: Localised;
  };
  money: (minor: number, currency: string, locale: Locale) => string;
  shipmentPhrase: (status: string, locale: Locale) => string | null;
  t: {
    greeting: (storeName: string, locale: Locale) => string;
    browseBody: Localised;
    browseButton: Localised;
    moreRow: Localised;
    outOfStockTag: Localised;
    emptyCatalog: Localised;
    storeUnavailable: Localised;
    askQuantity: (title: string, locale: Locale) => string;
    cartSummary: (lines: { title: string; quantity: number }[], subtotal: string, locale: Locale) => string;
    cartButtons: { checkout: Localised; addMore: Localised; clear: Localised };
    cartEmpty: Localised;
    choosePayment: Localised;
    paymentTitles: { cod: Localised; link: Localised; instapay: Localised };
    chooseAddress: Localised;
    addressesButton: Localised;
    newAddressRow: Localised;
    /** Optional (Ruling CHAT-AGENT-3): a returning customer with a default address is asked "same address as last time?" with two buttons instead of the list. Without it the list is always shown. */
    sameAddress?: (summary: string, locale: Locale) => string;
    sameAddressYes?: Localised;
    sameAddressNo?: Localised;
    askAddress: Localised;
    /** Optional: a location pin is accepted as the delivery address. Without them a pin is ignored in the address step. */
    pinReceived?: (label: string, locale: Locale) => string;
    pinNeedsText?: Localised;
    outOfStock: (names: string[], locale: Locale) => string;
    codPlaced: (orderNumber: string, total: string | null, locale: Locale) => string;
    linkPlaced: (orderNumber: string, url: string, locale: Locale) => string;
    instapayPlaced: (orderNumber: string, ipa: string, amount: string, reference: string, locale: Locale) => string;
    awaitingReceipt: Localised;
    proofReceived: Localised;
    proofAlready: Localised;
    proofExpired: Localised;
    paymentConfirmed: (orderNumber: string, locale: Locale) => string;
    orderFailed: Localised;
    useButtons: Localised;
    codConfirmed: Localised;
    codRefused: Localised;
    ordersHeader: Localised;
    orderLine: (orderNumber: string, status: string, locale: Locale) => string;
    noOrders: Localised;
    orderStatusNames: Record<string, Localised>;
    /** WhatsApp catalogue messages (product cards, the catalogue button) and the cart sent from the catalogue. Limits: header 60, section title 24, footer 60, body 1024. */
    cards: {
      single: (title: string, price: string, locale: Locale) => string;
      listHeader: Localised;
      listBody: Localised;
      listSection: Localised;
      moreSection: Localised;
      catalogBody: Localised;
      catalogFooter: Localised;
      /** A cart line the Store no longer sells (or whose id it does not know). */
      cartUnknown: (names: string[], locale: Locale) => string;
      /** The cart's prices were not the live prices: the live ones apply. */
      cartRepriced: Localised;
      /** Every cart line was gone: nothing left to order. */
      cartAllGone: Localised;
      /** The cart came from a catalogue that is not this store's. */
      cartOtherCatalogue: Localised;
    };
  };
};
