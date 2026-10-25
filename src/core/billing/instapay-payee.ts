/** Who a merchant pays by InstaPay. Brand-neutral: the brand pack maps its own settings into this shape. */
export type InstapayPayee = { handle: string; name: string; qrUrl: string | null };
