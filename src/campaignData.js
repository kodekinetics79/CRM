const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const cents=value=>{if(!Number.isSafeInteger(value)||value<0)throw new Error('Campaign monetary values must be safe nonnegative integer cents.');return value;};
const total=rows=>{let amount=0n;for(const gift of rows)amount+=BigInt(cents(gift.amount));if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Campaign contribution total exceeds safe integer cents.');return Number(amount);};

// Lifetime progress uses actual source dates, independently of school-year assignments
// and campaign-window metadata. Future records remain inspectable, separate from raised.
export function campaignProgress(gifts,{campaignId,goalCents=0,asOf}){
 if(!validDay(asOf))throw new Error('Campaign progress requires a valid explicit as-of date.');
 cents(goalCents);
 const sourceGifts=gifts.filter(g=>g.campaignId===campaignId);
 const eligible=sourceGifts.filter(g=>g.status==='Posted'&&!['In-kind','Fee payment'].includes(g.type));
 for(const gift of eligible)if(!validDay(gift.date))throw new Error('Campaign gift source dates must be valid calendar dates.');
 const currentGifts=eligible.filter(g=>g.date<=asOf),futureGifts=eligible.filter(g=>g.date>asOf);
 const currentAmountCents=total(currentGifts),futureAmountCents=total(futureGifts);
 return {asOf,goalCents,sourceGifts,currentGifts,futureGifts,currentAmountCents,futureAmountCents,progressPercent:goalCents?currentAmountCents/goalCents*100:0};
}
