/**
 * Input rail 3b: scope + abuse + injection classifier (plan 4 Task A4, spec 6.9). Deterministic Arabic / Franco / English lexicon first
 * (ruling SL-GUARD-1: no Llama Guard, no AI Gateway guardrails: Arabic unsupported); a model call on the classify job only when the
 * lexicon neither blocks nor recognises the text as store vocabulary. A lexicon block can never be overridden by the model, and a model
 * failure never blocks a store question (it degrades to `ok`).
 */
import { foldArabic } from '../../text';
import { francoToArabic } from './franco';

export type ScopeVerdict = 'ok' | 'off_topic' | 'abuse' | 'super_admin' | 'injection';
export type Classify = (t: string) => Promise<{ inScope: boolean; abuse: boolean; injection: boolean }>;

// Patterns run on `foldArabic(text) + ' | ' + foldArabic(francoToArabic(text))`: alef forms folded to ا, ى to ي, ة to ه, lower-case Latin.
const INJECTION: RegExp[] = [
  /ignore\s+(?:(?:all|any|the|your|my|every)\s+)*(?:(?:previous|prior|above|earlier|former)\s+)?(?:instructions?|rules?|prompts?|guidelines?|messages?)/,
  /disregard\s+(?:\w+\s+){0,3}(?:instructions?|rules?|prompts?)/,
  /(?:forget|override)\s+(?:\w+\s+){0,3}(?:instructions?|rules?|prompt)/,
  /system\s*prompt|developer\s*(?:message|prompt)|hidden\s*(?:prompt|instructions)/,
  /\byou\s+are\s+now\b|\bjailbreak|\bdan\s+mode|\bpretend\s+(?:you|to)\b/,
  /reveal\s+(?:\w+\s+){0,2}(?:prompt|instructions)/,
  /تجاهل\s+(?:\S+\s+){0,2}?(?:التعليمات|الاوامر|القواعد|ما\s*سبق|كل\s*شي)/,
  /(?:انسي|انسوا|الغي)\s+(?:\S+\s+){0,3}?(?:التعليمات|الاوامر|القواعد|اللي\s*فات|ما\s*سبق)/,
  /(?:اظهر|اطبع|قول|وريني|هات|اكشف)\w*\s+(?:\S+\s+){0,3}?(?:التعليمات|البرومبت|system\s*prompt|تعليمات\s*النظام)/,
  /(?:برومبت|تعليمات)\s*النظام/,
  /\bt[a]?gahal\b|\btagahel\b|\bta3?limat\s*(?:el\s*)?(?:nezam|system)|\bnsa\s+kol\s+el\s+ta3?l/,
  /انت\s+دلوقتي\s+(?:مش\s+)?(?:مساعد|ادمن|مدير)/,
];
const SUPER_ADMIN: RegExp[] = [
  /(?:ادخلني|دخلني|افتحلي|وريني|هاتلي)\s+(?:\S+\s+){0,2}?(?:متجر|محل|حساب|بيانات)\s+(?:\S+\s+){0,2}?(?:تاني|اخر|تانيه|غيري|حد|عميل)/,
  /(?:ادخلني|دخلني)\s+(?:علي|ع)\s+(?:متجر|حساب)/,
  /(?:فعل|فعلي|رقي|رقيني|ركب)\w*\s+(?:\S+\s+){0,3}?(?:ال)?(?:باقه|خطه|اشتراك|بيزنس|بريميوم|premium|business|plan)\S*\s+(?:\S+\s+){0,2}?(?:من\s+غير|بدون|ببلاش|مجان)/,
  /(?:خليني|اعملني|خلني|اديني)\s+(?:\S+\s+){0,2}?(?:ادمن|admin|سوبر|مدير\s*النظام|صلاحيات\s*(?:ادمن|كامله))/,
  /بيانات\s+(?:ال)?متاجر\s+(?:التانيه|الاخري|تانيه)/,
  /impersonat|super[\s_-]*admin|make\s+me\s+(?:an?\s+)?admin|(?:other|another)\s+(?:store|merchant|user)'?s?\b/,
  /bypass\s+(?:the\s+)?(?:payment|billing|paywall)|(?:plan|subscription|upgrade|package)\b[^.|]{0,30}\b(?:without|no)\s+(?:paying|payment)|(?:without|no)\s+(?:paying|payment)\b[^.|]{0,30}\b(?:plan|subscription|upgrade|package)/,
  /\b(?:edkhol|adkhol|dakhalny|dkhlny|edkholny)\b[^|]{0,30}\b(?:tany|taany|ghery|ghairy)\b/,
  /\b(?:fa33al|fa3al|fa3el|raqqy|rakkeb)\b[^|]{0,30}\b(?:ba2a|baqa|plan|package)\b[^|]{0,20}\bmen\s+gh[ae]?i?r\b/,
];
const ABUSE: RegExp[] = [
  /(?:يا|ابن|ابو)\s+(?:ال)?(?:كلب|حمار|حيوان|خول|شرموط|وسخ|ز?فت|عرص|متناك)/,
  /شرموط|متناك|منيوك|كس\s*ام|كسمك|كسم/,
  /\b(?:fuck|shit|bitch|asshole|bastard|motherfucker|cunt)\b/,
  /\bya\s+(?:kalb|7mar|hmar|gaba|khawal|ars|haywan)\b|\bsharmoot|\bkos\s*omak|\bkosomak|\bibn\s+el\s+(?:kalb|sharmoota)/,
  /(?:ابيع|ببيع|اشتري|عايز\s+ابيع|عايز\s+اشتري|بيع)\s+(?:\S+\s+){0,3}?(?:مخدرات|حشيش|بانجو|ترامادول|سلاح|اسلحه|مسروق|مزور|مقلد|ممنوع)/,
  /(?:مخدرات|حشيش|بانجو|ترامادول)/,
  /(?:sell|buy|selling|buying)\s+(?:\w+\s+){0,3}(?:drugs?|weapons?|guns?|stolen|counterfeit|fake\s+ids?|cocaine|hash(?:ish)?)/,
  /\b(?:7ashish|hashish|tramadol|banjo)\b|\bcarding\b/,
];
const OFF_TOPIC: RegExp[] = [
  /اكتب(?:ل[يى])?\s*(?:لي\s*)?(?:ل[يى]\s*)?(?:قصيده|شعر|مقاله|قصه|رساله\s*حب|اغنيه|روايه)/,
  /اكتب(?:ل[يى])?\s*(?:لي\s*)?كود\s+(?:بايثون|python|جافا|java|html|css|sql|برمج|برنامج)/,
  /(?:احكي|احكيلي|قولي)\s*(?:ل[يى])?\s*(?:نكته|قصه|حدوته)/,
  /(?:حل|حلي)\s+(?:ال)?(?:واجب|معادله|مساله)/,
  /(?:مين|من)\s+(?:كسب|فاز|هيكسب|هيفوز)\s+(?:ال)?(?:ماتش|دوري|كاس|مباراه)/,
  /(?:ال)?طقس\s+(?:بكره|النهارده|امبارح)|احوال\s+الطقس/,
  /وصفه\s+(?:اكل|كشري|محشي|كيك)/,
  /write\s+(?:me\s+)?(?:an?\s+)?(?:poem|essay|story|song|joke|novel|python|javascript|code|script|program)/,
  /(?:python|javascript|java|c\+\+)\s+(?:code|script|program)/,
  /who\s+won\b|\bweather\b|\brecipe\b|\bhomework\b|tell\s+me\s+a\s+joke|\blottery\b/,
  /\bmeen\s+(?:ksb|kesb|faz|ksb)\b|\bekt[eoa]?b?l[iy]\b[^|]{0,40}\b(?:code|python|poem|2a?s[iy]da|ksida|shi3r|sher|maqal|2issa)\b/,
];
const IN_SCOPE: RegExp[] = [
  /منتج|اوردر|طلب|كوبون|خصم|عرض|شحن|توصيل|دومين|متجر|محل|عميل|عملاء|دفع|مخزون|كميه|قالب|تيمبلت|حمله|رسايل|رساله|واتساب|جهات\s*الاتصال|شريحه|بوت|فاتوره|صفحه|ثيم|باقه|اشتراك|مرتجع|استرجاع|سعر|اسعار|تقرير|كتالوج|فرع|موظف|صلاحي|اعدادات|تصنيف|قسم|مدونه|ايميل|اشعار|الاشعارات|ضريبه|محاسب/,
  /\b(?:product|products|order|orders|coupon|coupons|discount|discounts|shipping|delivery|domain|store|shop|customer|customers|payment|payments|stock|inventory|template|templates|campaign|campaigns|whatsapp|contact|contacts|segment|bot|invoice|page|theme|seo|plan|subscription|refund|refunds|price|prices|report|catalog|catalogue|staff|settings|category|blog|tax|account)\b/,
];

const view = (text: string): string => `${foldArabic(text)} | ${foldArabic(francoToArabic(text))}`;
const hit = (res: RegExp[], v: string): boolean => res.some((r) => r.test(v));

/** Lexicon-only verdict; `undecided` means no block and no store vocabulary either. */
function lexicon(text: string): ScopeVerdict | 'undecided' {
  const v = view(text);
  if (hit(INJECTION, v)) return 'injection';
  if (hit(SUPER_ADMIN, v)) return 'super_admin';
  if (hit(ABUSE, v)) return 'abuse';
  if (hit(OFF_TOPIC, v)) return 'off_topic';
  return hit(IN_SCOPE, v) ? 'ok' : 'undecided';
}

export async function scopeCheck(text: string, classify?: Classify): Promise<{ verdict: ScopeVerdict; by: 'lexicon' | 'model' }> {
  const lx = lexicon(text);
  if (lx !== 'undecided') return { verdict: lx, by: 'lexicon' };
  if (!classify) return { verdict: 'ok', by: 'lexicon' };
  try {
    const r = await classify(text);
    if (r.injection) return { verdict: 'injection', by: 'model' };
    if (r.abuse) return { verdict: 'abuse', by: 'model' };
    return { verdict: r.inScope ? 'ok' : 'off_topic', by: 'model' };
  } catch {
    return { verdict: 'ok', by: 'lexicon' }; // the model leg fails open; only the lexicon blocks
  }
}
