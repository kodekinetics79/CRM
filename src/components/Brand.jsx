import React from 'react';

export function BrandMark({className=''}) {
  return <span className={'brand-mark '+className}><img src="/brand/wimblo-gather.png" width="44" height="44" alt="" aria-hidden="true"/></span>;
}

export default function Brand() {
  return <><BrandMark/><span className="brand-name">wimblo</span></>;
}
