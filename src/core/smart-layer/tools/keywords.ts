/**
 * Search words for the tool retrieval rail (plan 4 Task A6). The rail matches a merchant's words (Egyptian Arabic, Franco folded to Arabic, English) against each
 * tool's capability title, example questions and DESCRIPTION; the descriptions are English, so the words a merchant actually says live here and are appended to the
 * description the model sees. A tool nobody can reach by asking is a tool that does not exist: `test/smart-layer/eval.test.ts` asks for every tool in Arabic.
 */
export const KEYWORDS: Readonly<Record<string, string>> = {
  conversation_tag_set: 'تاج وسم تصنيف المحادثة العميل حط ضيف',
  conversation_note_add: 'ملاحظة ملحوظة داخلية على المحادثة العميل ضيف اكتب',
  conversation_assign: 'حوّل المحادثة لموظف مسؤول اسند وزع العميل',
  contact_tags_set: 'تاج وسم تصنيف العميل حط ضيف',
  contact_rename: 'اسم العميل غيّر الاسم غلط عدّل',
  contact_erase: 'امسح احذف شيل العميل نهائيا حذف بيانات',
  contact_merge: 'ادمج دمج العميل نفس الشخص رقم جديد',
  segment_upsert: 'شريحة شرايح قسم جمهور عملاء اعمل انشئ عدّل فلتر',
  segment_delete: 'امسح احذف شريحة شرايح جمهور',
  bot_menu_set: 'قائمة الخدمات المنيو البوت عدّل غيّر',
  bot_hours_set: 'مواعيد العمل ساعات رسالة الغياب مقفولين البوت',
  bot_location_set: 'موقع العنوان المحل لوكيشن البوت',
  bot_ordering_toggle: 'بوت الطلبات شغّل اوقف اقفل افتح الاوردر',
  bot_order_confirmations_toggle: 'رسايل تأكيد الطلب الاوردر العميل شغّل اوقف',
  catalogue_resync: 'كتالوج مزامنة سينك المنتجات واتساب',
  catalogue_toggles_set: 'كتالوج زرار المتجر السلة كارت واتساب اظهر اخفي',
  catalogue_link_existing: 'كتالوج اربط رقم الكتالوج ميتا موجود',
  agent_persona_set: 'الموظف الذكي شخصية لغة بيتكلم يرد البوت الذكاء الاصطناعي غيّر',
  agent_faq_update: 'الاسئلة الشائعة معلومات معرفة الموظف الذكي ضيف عدّل اكتب',
  digest_settings_set: 'الملخص الاسبوعي ملخص الاسبوع اوقف شغّل',
  seat_assign: 'مقعد موظف الشات إدّي اضيف صلاحية',
  campaign_draft: 'حملة مسودة جهّز اعمل رسالة جماعية قالب جمهور شريحة',
  campaign_send_now: 'ابعت ارسل حملة دلوقتي الان شغّل',
  campaign_schedule: 'جدول حملة موعد وقت بعدين ابعت بكرة',
  campaign_pause: 'وقف مؤقت حملة اوقف استنى',
  campaign_resume: 'كمّل استكمل حملة شغّل تاني',
  campaign_cancel: 'الغي إلغاء حملة وقف نهائي',
  campaign_delete_draft: 'امسح احذف مسودة حملة',
  send_text: 'ابعت ارسل رسالة نص للعميل كلم رد',
  send_template: 'ابعت ارسل قالب template للعميل رسالة',
  template_write: 'اكتب اكتبلي قالب template رسالة رسائل جاهزة صياغة مسودة ميتا العميل الأوردر الطلب اتشحن وصل جاهز الاستلام تأكيد كود تحقق عرض خصم العيد سلة تذكير تذكر استرجاع تقييم رجع الدفع write draft message templates customer order shipped delivered refund reminder offer promotion discount cart verification code confirm cash delivery pickup stock review payment resala qaleb template ektb akteb 3ayez order shahan wasal kod tahakok khasm 3ard el3id salla tazkeer esterga3 taqyeem raga3 daf3',
  template_fix: 'صلّح اصلح قالب template اترفض رفض ميتا مرفوض',
  template_submit: 'قالب template قدّم ابعت لميتا مراجعة اعتماد جديد',
  template_edit: 'قالب template عدّل غيّر صلّح ميتا مراجعة',
  template_delete: 'قالب template امسح احذف',
  templates_install_defaults: 'قوالب البداية نزّل ثبّت القوالب الجاهزة ميتا',
};
export const withKeywords = <T extends { name: string; description: string }>(t: T): T => (KEYWORDS[t.name] ? { ...t, description: `${t.description} [${KEYWORDS[t.name]}]` } : t);
