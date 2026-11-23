import { STRINGS, type Lang, type Strings } from './i18n';

/**
 * CHAT-SA-5: a standalone workspace has no Store behind it, so no surface a person there can see says "store" / "متجر".
 * These are replacements for the keys that do, applied only when GET /me says `kind === 'standalone'`; a Store workspace keeps STRINGS untouched.
 * Keys that belong to hidden store-coupled sections (catalogue, order confirmations, product suggestions) are not listed: their screens are not rendered.
 */
const OVERRIDES: Record<Lang, Partial<Strings>> = {
  ar: {
    agentFaq: 'أسئلة وأجوبة شغلك',
    botIntro: 'هنا بتظبط اللي البوت بيقوله لعملائك: قايمة الأسئلة الجاهزة، مواعيد شغلك، وعنوان مكانك.',
    botReadOnly: 'تقدر تشوف الإعدادات بس. التعديل لصاحب مساحة العمل.',
    botMenuRows: 'واتساب بيعرض 10 اختيارات بالكتير. ولو ضفت عنوان ممكن عدد الأسئلة اللي بتظهر يقل.',
    botLocTitle: 'عنوان المكان',
    notAllowed: 'مش مسموح لحضرتك تفتح الصفحة دي. اطلب من صاحب مساحة العمل.',
    connReadOnly: 'حضرتك بتشوف حالة الموصّلات بس. صاحب مساحة العمل هو اللي يضيف أو يعدّل.',
    apiPlan: 'ميزة الـ API في باقات الشات اللي فيها «ميزة الـ API»، وبتتفعّل لمساحة عملك قبل الاستخدام.',
    ownerOnly: 'الإعدادات دي لصاحب مساحة العمل بس.',
    gateBody: 'سجّل دخولك بحسابك علشان تفتح صندوق رسايل مساحة عملك.',
    ownerSends: 'صاحب مساحة العمل بس هو اللي يقدر يبعت حملة أو يكمّلها.',
    numbersIntro: 'اربط رقم واتساب بتاع شغلك. لو بتستخدم تطبيق واتساب بيزنس على الرقم ده، هيفضل شغال عادي وكمان هتستقبل الرسايل هنا.',
    wOffFrozen: 'في طلب مسح لمساحة العمل دي، فالشحن وشراء الباقات واقفين. لو عايز تكمّل، ألغي طلب المسح الأول من آخر بطاقة في صفحة المحفظة.',
    teamEmpty: 'مفيش موظفين لسه. ضيف موظف لمساحة عملك وبعدين إدّيه مقعد هنا.',
    noSeatBody: 'صاحب مساحة العمل لسه ما إداكش مقعد على واتساب. اطلب منه يفتح صفحة الفريق ويديك مقعد، وبعدين جرّب تاني.',
    noSeatOver: 'مقعدك متوقف لأن باقة مساحة العمل اتغيّرت. اطلب من صاحبها يرقّي الباقة أو يفضّي مقعد.',
    offTitle: 'امسح حساب واتساب الخاص بمساحة العمل دي',
    offWhat: 'بعد 14 يوم من تأكيدك بنوقف أي إرسال، ونفصل أرقامك، ونمسح المحادثات وجهات الاتصال والملفات والحملات والنسخ الاحتياطية. سجلات المدفوعات والاسترداد بتفضل محفوظة من غير اسم مساحة عملك زي ما القانون بيطلب. تقدر تلغي في أي وقت قبل ما الـ 14 يوم يخلصوا.',
    tplStaffNote: 'إنت بتشوف القوالب للقراءة بس. صاحب مساحة العمل هو اللي يقدر ينشئ أو يعدّل أو يمسح.',
    assistantOff: 'المساعد مش شغال على مساحة عملك دلوقتي. لما يتفتح هيظهر لوحده.',
    storeMenu: 'مساحات العمل والحساب', storeMenuCurrent: 'مساحة العمل الحالية', storeMenuSwitch: 'غيّر مساحة العمل', storeUnnamed: 'مساحة العمل دي', storeMenuNone: 'مفيش مساحات عمل تانية ليك.',
  },
  en: {
    agentFaq: 'Your business Q&A',
    botIntro: 'What the bot tells your customers: the ready-made questions, your opening hours and your address.',
    botReadOnly: 'You can view these settings. Only the workspace owner can change them.',
    botMenuRows: 'WhatsApp shows at most 10 choices. If you add a location, fewer questions may fit.',
    botLocTitle: 'Business location',
    notAllowed: 'You are not allowed to open this page. Ask the workspace owner.',
    connReadOnly: 'You can see the status of the connectors only. The workspace owner adds or changes them.',
    apiPlan: 'The API feature comes with the Chat packages that list "API" as a feature and is switched on for your workspace before use.',
    ownerOnly: 'Only the workspace owner can change these settings.',
    gateBody: 'Sign in with your account to open your workspace inbox.',
    ownerSends: 'Only the workspace owner can send or resume a campaign.',
    numbersIntro: 'Connect your business WhatsApp number. If you use the WhatsApp Business app on it, it keeps working and messages also arrive here.',
    wOffFrozen: 'A deletion has been requested for this workspace, so top-ups and package purchases are paused. To continue, cancel the deletion first (the last card on the Wallet page).',
    teamEmpty: 'No staff yet. Add a staff member to your workspace, then give them a seat here.',
    noSeatBody: 'The workspace owner has not given you a seat on WhatsApp yet. Ask them to open the Team page and give you one, then try again.',
    noSeatOver: 'Your seat is paused because the workspace package changed. Ask the owner to upgrade the package or free a seat.',
    offTitle: 'Delete this workspace\'s WhatsApp account',
    offWhat: 'Fourteen days after you confirm we stop all sending, disconnect your numbers, and delete your conversations, contacts, files, campaigns and backups. Payment and refund records stay, without your workspace\'s name, as the law requires. You can cancel any time before the 14 days end.',
    tplStaffNote: 'You can view templates only. The workspace owner creates, edits and deletes them.',
    assistantOff: 'The assistant is not turned on for your workspace right now. It appears by itself when it is.',
    storeMenu: 'Workspaces and account', storeMenuCurrent: 'Current workspace', storeMenuSwitch: 'Switch workspace', storeUnnamed: 'This workspace', storeMenuNone: 'You have no other workspaces.',
  },
};

/** The strings for a session: the shared table, with workspace wording when the session is a standalone workspace. */
export function stringsFor(lang: Lang, standalone: boolean | undefined): Strings {
  const base = STRINGS[lang];
  if (!standalone) return base;
  return {
    ...base,
    ...OVERRIDES[lang],
    teamRoles: { ...base.teamRoles, owner: lang === 'ar' ? 'صاحب مساحة العمل' : 'Workspace owner' },
    consentSource: { ...base.consentSource, link: lang === 'ar' ? 'رابط أو دفع' : 'Link or payment' },
  } as Strings;
}

/** A Store person who also belongs to a standalone workspace: only the picker's words change ("workspaces"), every other string stays the Store one. */
export function withWorkspacePicker(t: Strings, lang: Lang, source: { standalone?: boolean; stores?: { kind?: 'store' | 'standalone' }[] }): Strings {
  if (source.standalone || !source.stores?.some((x) => x.kind === 'standalone')) return t;
  const o = OVERRIDES[lang];
  return { ...t, storeMenu: o.storeMenu!, storeMenuCurrent: o.storeMenuCurrent!, storeMenuSwitch: o.storeMenuSwitch!, storeMenuNone: o.storeMenuNone! };
}

/** Copy for the create-workspace screen (a person with no Store and no workspace yet). */
export const CREATE_WS = {
  ar: {
    title: 'اعمل مساحة عملك على ابدأ شات',
    intro: 'مساحة العمل هي المكان اللي فيه صندوق رسايل عملائك وحملاتك ومساعدك الذكي. هتعملها مرة واحدة وتربط رقم واتساب بتاعك بعدها.',
    name: 'اسم مساحة العمل', namePlaceholder: 'مثلًا: مكتب النور للتسويق', nameHint: 'ده الاسم اللي هتشوفه إنت وفريقك. تقدر تغيّره بعدين.',
    country: 'الدولة', countryValue: 'مصر', countryHint: 'ابدأ شات متاح حاليًا في مصر بس.',
    invite: 'كود الدعوة', inviteHint: 'الكود وصلك من فريق ابدأ ستوديو. بيتستخدم مرة واحدة.',
    submit: 'اعمل مساحة العمل', busy: 'بنجهّز مساحة عملك…',
    nameNeeded: 'اكتب اسم لمساحة العمل.',
    inviteNeeded: 'اكتب كود الدعوة اللي وصلك.',
    errors: {
      standalone_off: 'عمل مساحات العمل الجديدة مقفول دلوقتي. هنبلّغك أول ما يتفتح.',
      invite_required: 'محتاج كود دعوة علشان تعمل مساحة عمل. اطلبه من فريق ابدأ ستوديو.',
      invite_invalid: 'الكود ده مش شغال. اتأكد إنك كتبته صح، أو إنه ما اتستخدمش قبل كده ولا انتهى، وجرّب تاني.',
      rate_limited: 'جرّبت مرات كتير. استنى شوية وجرّب تاني.',
      failed: 'مقدرناش نعمل مساحة العمل. جرّب تاني بعد شوية.',
    },
    closedTitle: 'مفيش مساحة عمل على حسابك لسه',
    closedBody: 'عمل مساحات العمل الجديدة مقفول دلوقتي، ومفيش مساحة عمل مربوطة بالحساب ده. لو عندك كود دعوة أو محتاج مساعدة، كلّم فريق ابدأ ستوديو.',
    invTitle: 'دعوات مستنياك', invIntro: 'اتدعيت تشتغل على مساحة عمل على ابدأ شات. اقبل الدعوة علشان تفتحها.',
    invExpires: 'الدعوة بتنتهي', invAccept: 'اقبل الدعوة', invAccepting: 'بنقبل الدعوة…', invCreateInstead: 'أو اعمل مساحة عملك إنت',
    invErrors: {
      not_found: 'الدعوة دي خلصت أو اتلغت أو اتقبلت قبل كده. اطلب من صاحب مساحة العمل يبعتلك دعوة جديدة.',
      seat_limit: 'مساحة العمل دي مفيهاش مقاعد فاضية دلوقتي. اطلب من صاحبها يفضّي مقعد، وبعدين اقبل الدعوة تاني.',
      failed: 'مقدرناش نقبل الدعوة. جرّب تاني بعد شوية.',
    },
    loadFailed: 'مقدرناش نفتح حسابك دلوقتي. جرّب تاني.', retry: 'جرّب تاني',
  },
  en: {
    title: 'Create your workspace on Ebda Chat',
    intro: 'Your workspace holds your customer inbox, your campaigns and your AI agent. You create it once, then connect your WhatsApp number.',
    name: 'Workspace name', namePlaceholder: 'For example: Al Nour Marketing', nameHint: 'You and your team see this name. You can change it later.',
    country: 'Country', countryValue: 'Egypt', countryHint: 'Ebda Chat is available in Egypt only for now.',
    invite: 'Invite code', inviteHint: 'The Ebda AI Studio team sent you this code. It works once.',
    submit: 'Create the workspace', busy: 'Setting up your workspace…',
    nameNeeded: 'Enter a name for the workspace.',
    inviteNeeded: 'Enter the invite code you received.',
    errors: {
      standalone_off: 'Creating new workspaces is closed right now. We will let you know when it opens.',
      invite_required: 'You need an invite code to create a workspace. Ask the Ebda AI Studio team for one.',
      invite_invalid: 'That code did not work. Check you typed it correctly, and that it has not been used or expired, then try again.',
      rate_limited: 'Too many tries. Wait a moment and try again.',
      failed: 'We could not create the workspace. Try again in a moment.',
    },
    closedTitle: 'Your account has no workspace yet',
    closedBody: 'Creating new workspaces is closed right now, and no workspace is linked to this account. If you have an invite code or need help, talk to the Ebda AI Studio team.',
    invTitle: 'Invitations waiting for you', invIntro: 'You were invited to work in a workspace on Ebda Chat. Accept the invitation to open it.',
    invExpires: 'Invitation expires', invAccept: 'Accept the invitation', invAccepting: 'Accepting…', invCreateInstead: 'Or create your own workspace',
    invErrors: {
      not_found: 'This invitation has expired, been withdrawn or already been accepted. Ask the workspace owner to send a new one.',
      seat_limit: 'This workspace has no free seat right now. Ask its owner to free one, then accept the invitation again.',
      failed: 'We could not accept the invitation. Try again in a moment.',
    },
    loadFailed: 'We could not open your account right now. Try again.', retry: 'Try again',
  },
} as const;
