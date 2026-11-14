export type AdviceKind = 'format' | 'policy' | 'length' | 'duplicate' | 'category' | 'unknown';
export type TemplateAdvice = { ar: string; en: string; kind: AdviceKind };

const ADVICE: Record<AdviceKind, { ar: string; en: string }> = {
  format: {
    ar: 'ميتا رفضت القالب بسبب شكل المتغيّرات. اتأكد إن كل متغيّر مكتوب كده {{1}} بقوسين من كل ناحية، وإنهم متسلسلين من غير ما تسيب رقم، وإن الرسالة متبدأش ولا تخلّص بمتغيّر، وإن كل متغيّر له مثال. بعد التصليح اضغط «عدّل وابعت تاني».',
    en: 'Meta rejected the template because of how the variables are formatted. Check every variable is written like {{1}} with two braces on each side, they run in order with no gaps, the message does not start or end with a variable, and every variable has an example. Then press "Edit and resubmit".',
  },
  policy: {
    ar: 'ميتا رفضت القالب لأن المحتوى مخالف لسياستها (مثلاً كلام تجاري ممنوع، أو بيانات حساسة، أو أسلوب يشبه النصب). اكتب الرسالة بشكل أهدى وأوضح من غير ضغط على العميل، وبعدين «عدّل وابعت تاني».',
    en: "Meta rejected the template because the content breaks its policy (for example a prohibited commerce claim, sensitive data, or wording that reads like a scam). Rewrite it calmer and clearer, without pressuring the customer, then press \"Edit and resubmit\".",
  },
  length: {
    ar: 'ميتا رفضت القالب بسبب الطول أو الإيموجي. قصّر الرسالة، وقلّل الإيموجي، وخلّي المتغيّرات قليلة بالنسبة لطول الكلام، وبعدين «عدّل وابعت تاني».',
    en: 'Meta rejected the template because of its length or emojis. Shorten the message, use fewer emojis, keep variables few for the length of the text, then press "Edit and resubmit".',
  },
  duplicate: {
    ar: 'ميتا رفضت القالب لأن عندك قالب تاني بنفس النص ونفس السطر الأخير. غيّر النص عن القالب القديم أو امسح القديم، وبعدين «عدّل وابعت تاني».',
    en: 'Meta rejected the template because you already have one with the same text and footer. Change the text, or delete the old one, then press "Edit and resubmit".',
  },
  category: {
    ar: 'ميتا شايفة إن القسم اللي اخترته مش مناسب لمحتوى الرسالة (مثلاً رسالة فيها عرض أو خصم محطوطة كرسالة خدمة). غيّر القسم لـ «رسائل تسويق» أو شيل الكلام الترويجي، وبعدين «عدّل وابعت تاني».',
    en: 'Meta thinks the category does not match the message (for example an offer or discount filed as a service message). Change it to "marketing messages" or remove the promotional wording, then press "Edit and resubmit".',
  },
  unknown: {
    ar: 'ميتا رفضت القالب ومحدّدتش سبب واضح. راجع الرسالة على قواعد القوالب (المتغيّرات، الطول، القسم، وإن مفيش تكرار)، وعدّلها وابعتها تاني. لو اتكررت، افتح تذكرة دعم وابعتلنا كود السبب اللي ظاهر تحت.',
    en: 'Meta rejected the template without a clear reason. Check the message against the template rules (variables, length, category, no duplicates), edit it and submit again. If it keeps happening, open a support ticket with the reason code shown below.',
  },
};

/** Meta's own reason codes. Meta's docs do not list the full set: extend test/fixtures/template-reasons.json with real captures. */
const BY_CODE: Record<string, AdviceKind> = {
  INVALID_FORMAT: 'format', ABUSIVE_CONTENT: 'policy', SCAM: 'policy', TAG_CONTENT_MISMATCH: 'category', INCORRECT_CATEGORY: 'category',
};
/** The four documented rejection themes (parameter formatting, policy, length/emoji, duplicate), matched by wording when the code is unfamiliar. */
const BY_WORDING: [RegExp, AdviceKind][] = [
  [/duplicate|same (body|content)/i, 'duplicate'],
  [/too long|length|emoji/i, 'length'],
  [/param|variable|brace|format/i, 'format'],
  [/polic|commerce|scam|abus|sensitive/i, 'policy'],
  [/categor/i, 'category'],
];

/** Whether a reason maps to a documented code or theme. `null` (no reason) has nothing to capture. */
export function knownReason(reason: string | null): boolean {
  if (!reason || reason === 'NONE') return true;
  return reason in BY_CODE || BY_WORDING.some(([re]) => re.test(reason));
}

/** Meta's reason codes are enum-like. Only a value of that shape is safe to log for capture: anything else could carry a merchant's own words. */
export const isEnumLikeReason = (reason: string): boolean => /^[A-Z][A-Z0-9_]{2,63}$/.test(reason);

/**
 * Plain advice for a template Meta did not accept. Only the KIND is derived from the reason: the reason text itself is never echoed (it can
 * carry merchant text), and the screen shows the raw code separately. Healthy and in-flight statuses have no advice.
 */
export function rejectionAdvice(reason: string | null, status: string): TemplateAdvice | null {
  if (status === 'PAUSED') {
    return { kind: 'unknown', ar: 'ميتا أوقفت القالب ده مؤقتًا بسبب تقييمات سلبية من العملاء. تقدر تعدّله وتبعته تاني، وميتا هتراجعه من جديد.', en: 'Meta paused this template temporarily because of negative customer feedback. You can edit it and submit it again; Meta will review it afresh.' };
  }
  if (status === 'DISABLED') {
    return { kind: 'unknown', ar: 'القالب ده متعطّل من ميتا ومينفعش يتعدّل ولا يتمسح. اعمل قالب جديد بنص مختلف.', en: 'Meta has disabled this template; it cannot be edited or deleted. Create a new one with different text.' };
  }
  if (status !== 'REJECTED') return null;
  const code = reason && reason !== 'NONE' ? reason : null;
  const kind: AdviceKind = code === null ? 'unknown' : (BY_CODE[code] ?? BY_WORDING.find(([re]) => re.test(code))?.[1] ?? 'unknown');
  return { kind, ...ADVICE[kind] };
}
