import {contributedGifts,postedGifts,effectiveSchoolYear,sum} from './lib.js';

// Current CRM receipts use the same explicit UTC date boundary as server balances.
export function dashboardGiving(gifts,{schoolYear,fiscalStartMonth=7,asOf}) {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf))throw new Error('An explicit reporting date is required.');
 const period=postedGifts(gifts).filter(g=>effectiveSchoolYear(g,fiscalStartMonth)===schoolYear);
 const recordedThrough=period.filter(g=>g.date<=asOf);
 const contributions=contributedGifts(recordedThrough);
 const futureContributions=contributedGifts(period).filter(g=>g.date>asOf);
 return {asOf,recordedThrough,contributions,futureContributions,total:sum(contributions),futureTotal:sum(futureContributions),donorCount:new Set(contributions.map(g=>g.constituentId)).size};
}

export function matchesGiftScope(gift,scope={}) {
 return (!scope.schoolYear||effectiveSchoolYear(gift,scope.fiscalStartMonth??7)===scope.schoolYear)
  &&(!scope.month||gift.date.startsWith(scope.month))
  &&(!scope.asOf||gift.date<=scope.asOf)
  &&(!scope.futureAfter||gift.date>scope.futureAfter)
  &&(!scope.contributionsOnly||gift.status!=='Voided'&&!['Fee payment','In-kind'].includes(gift.type));
}
