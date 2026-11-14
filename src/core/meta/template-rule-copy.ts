import type { RuleIssue, RuleCode } from './template-rules';

type P = Record<string, string | number>;
type Copy = { ar: (p: P) => string; en: (p: P) => string };

/** One message per rule code: Egyptian Arabic first (full sentences), English second. The single source for the screen and the assistant. */
const COPY: Record<RuleCode, Copy> = {
  name_format: { ar: () => 'اسم القالب لازم يبقى حروف إنجليزي صغيرة وأرقام وشرطة سفلية بس، من غير مسافات.', en: () => 'The template name must be lowercase English letters, digits and underscores only, with no spaces.' },
  body_missing: { ar: () => 'اكتب نص الرسالة الأول، لأن القالب مينفعش يتبعت من غيره.', en: () => 'Write the message text first; a template cannot be sent without it.' },
  body_too_long: { ar: (p) => `نص الرسالة أطول من الحد اللي ميتا مسموحه بيه (${p.max} حرف). قصّره شوية.`, en: (p) => `The message text is longer than Meta allows (${p.max} characters). Please shorten it.` },
  variable_at_edge: { ar: () => 'متبدأش الرسالة ولا تخلّصها بمتغيّر زي {{1}}، وميتا بترفض ده. حط كلمة قبله أو بعده.', en: () => 'Do not start or end the message with a variable like {{1}}; Meta rejects that. Put a word before or after it.' },
  variable_gap: { ar: (p) => `المتغيّرات لازم تتسلسل من {{1}} من غير ما تسيب رقم، ومفيش {{${p.index}}} في النص.`, en: (p) => `Variables must run in order from {{1}} with no gaps, and {{${p.index}}} is missing from the text.` },
  braces_mismatch: { ar: () => 'فيه قوس ناقص أو زيادة في المتغيّرات. المتغيّر شكله {{1}} بقوسين من كل ناحية.', en: () => 'A variable has a missing or extra brace. A variable looks like {{1}} with two braces on each side.' },
  example_missing: { ar: (p) => `اكتب مثال للمتغيّر رقم ${p.index}، لأن ميتا بتطلبه عشان تراجع القالب.`, en: (p) => `Write an example for variable ${p.index}; Meta needs it to review the template.` },
  example_bad_chars: { ar: (p) => `مثال المتغيّر رقم ${p.index} فيه علامة مش مسموحة (# أو $ أو %). شيلها.`, en: (p) => `The example for variable ${p.index} contains a character that is not allowed (#, $ or %). Remove it.` },
  header_too_long: { ar: (p) => `العنوان أطول من ${p.max} حرف، وده الحد الأقصى عند ميتا.`, en: (p) => `The header is longer than ${p.max} characters, which is Meta's maximum.` },
  header_vars: { ar: (p) => `العنوان ينفع فيه ${p.max} متغيّر واحد بس.`, en: (p) => `The header can hold at most ${p.max} variable.` },
  footer_too_long: { ar: (p) => `السطر الأخير أطول من ${p.max} حرف، وده الحد الأقصى عند ميتا.`, en: (p) => `The footer is longer than ${p.max} characters, which is Meta's maximum.` },
  footer_variable: { ar: () => 'السطر الأخير مينفعش يحتوي على متغيّرات، اكتبه نص ثابت.', en: () => 'The footer cannot contain variables; write it as fixed text.' },
  buttons_too_many: { ar: (p) => `أقصى عدد أزرار ${p.max} في القالب الواحد.`, en: (p) => `A template can have at most ${p.max} buttons.` },
  qr_too_many: { ar: (p) => `أقصى عدد لأزرار الرد السريع ${p.max}.`, en: (p) => `At most ${p.max} quick-reply buttons are allowed.` },
  urls_too_many: { ar: (p) => `أقصى عدد لأزرار الروابط ${p.max}.`, en: (p) => `At most ${p.max} link buttons are allowed.` },
  phones_too_many: { ar: (p) => `مسموح بزر اتصال ${p.max} واحد بس.`, en: (p) => `Only ${p.max} call button is allowed.` },
  copy_too_many: { ar: () => 'مسموح بزر نسخ كود واحد بس.', en: () => 'Only one copy-code button is allowed.' },
  button_text_too_long: { ar: (p) => `كلام الزر أطول من ${p.max} حرف. قصّره.`, en: (p) => `A button label is longer than ${p.max} characters. Please shorten it.` },
  url_too_long: { ar: (p) => `الرابط أطول من ${p.max} حرف.`, en: (p) => `The link is longer than ${p.max} characters.` },
  url_variable_position: { ar: () => 'المتغيّر في الرابط لازم يبقى في آخره بالشكل {{1}}، ومتغيّر واحد بس.', en: () => 'The variable in a link must be at the very end, written {{1}}, and only one is allowed.' },
  qr_groups: { ar: () => 'أزرار الرد السريع لازم تتجمّع مع بعض، وباقي الأزرار مع بعض، من غير ما تتخلّط.', en: () => 'Quick-reply buttons must be grouped together and the other buttons grouped together, not mixed.' },
  phone_number_length: { ar: (p) => `رقم الاتصال أطول من ${p.max} خانة.`, en: (p) => `The phone number is longer than ${p.max} characters.` },
  copy_example_too_long: { ar: (p) => `مثال الكود أطول من ${p.max} حرف.`, en: (p) => `The code example is longer than ${p.max} characters.` },
  auth_forbidden_content: { ar: () => 'قوالب أكواد التحقق مينفعش فيها روابط ولا إيموجي ولا صور.', en: () => 'Verification-code templates cannot contain links, emojis or media.' },
  auth_expiry_range: { ar: (p) => `مدة صلاحية الكود لازم تبقى من ${p.min} لـ ${p.max} دقيقة.`, en: (p) => `The code expiry must be between ${p.min} and ${p.max} minutes.` },
  category_looks_promotional: { ar: () => 'الرسالة شكلها ترويجي (خصم أو عرض)، وميتا ممكن تحوّلها لرسائل تسويق وتتحاسب بسعر أعلى. لو دي رسالة ترويج اختار تسويق.', en: () => 'This looks promotional (a discount or an offer). Meta may reclassify it as marketing at a higher price. If it is a promotion, choose marketing.' },
  duplicate_body: { ar: () => 'عندك قالب تاني بنفس النص ونفس السطر الأخير، وميتا بترفض التكرار. غيّر النص أو عدّل القالب القديم.', en: () => 'Another template already has the same text and footer, and Meta rejects duplicates. Change the text or edit the existing template.' },
};

export function ruleMessage(issue: RuleIssue, lang: 'ar' | 'en'): string {
  return COPY[issue.code][lang](issue.params ?? {});
}
