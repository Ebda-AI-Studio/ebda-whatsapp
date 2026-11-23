/** Copy for the connection-health strip, plan meter and unread badge (UX audit #10). Spread into the shell strings as `hu`. */
export const huAr = {
    healthTitle: 'حالة رقم واتساب', usageTitle: 'استهلاك الباقة',
    ok: 'متصل', none: 'اربط رقمك', down: 'مفصول', warn: 'الجودة قلّت', bad: 'محتاج تدخّل',
    okBody: 'رقمك متصل وشغّال.', noneBody: 'اربط رقم واتساب بتاعك علشان تبدأ تتكلم مع العملاء وتشوف حالة الرقم هنا.', downBody: 'رقمك مفصول. العملاء مش هيوصلولك لحد ما ترجّعه.', warnBody: 'جودة الرقم قلّت أو فيه رقم ما خلصش تسجيله. صلّحه قبل ما واتساب يوقّف الإرسال.', badBody: 'واتساب قيّد الرقم أو جودته وحشة. افتح الرقم وشوف الخطوات.',
    tier: (n: string) => `حد الإرسال: ${n} عميل جديد في اليوم`, fix: 'صلّحه', connect: 'اربط الرقم', open: 'افتح الأرقام',
    credits: (left: string) => `${left} رصيد`, usageAria: (left: string, total: string) => `باقي ${left} رد ذكاء اصطناعي من ${total} في باقتك.`, usageAriaNoCap: (left: string) => `باقي ${left} رد ذكاء اصطناعي.`,
    usageWarn: 'الاستهلاك قرّب يخلص.', usageBad: 'رصيد الردود خلص.', walletLow: 'رصيد المحفظة قليل.', unreadNav: (n: string) => `${n} رسالة جديدة`,
    railStatus: 'حالة الحساب',
  };

export const huEn: typeof huAr = {
    healthTitle: 'WhatsApp number status', usageTitle: 'Plan usage',
    ok: 'Connected', none: 'Connect number', down: 'Disconnected', warn: 'Quality dropped', bad: 'Needs attention',
    okBody: 'Your number is connected and working.', noneBody: 'Connect your WhatsApp number to start talking to customers and see its health here.', downBody: 'Your number is disconnected. Customers cannot reach you until you reconnect it.', warnBody: 'The number quality dropped or a number did not finish registering. Fix it before WhatsApp pauses sending.', badBody: 'WhatsApp restricted the number or its quality is poor. Open the number to see the steps.',
    tier: (n: string) => `Sending limit: ${n} new customers a day`, fix: 'Fix it', connect: 'Connect the number', open: 'Open numbers',
    credits: (left: string) => `${left} credits`, usageAria: (left: string, total: string) => `${left} of ${total} AI replies left in your plan.`, usageAriaNoCap: (left: string) => `${left} AI replies left.`,
    usageWarn: 'Usage is close to the limit.', usageBad: 'AI reply credits ran out.', walletLow: 'Wallet balance is low.', unreadNav: (n: string) => `${n} new messages`,
    railStatus: 'Account status',
  };
