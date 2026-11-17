import { CorruptRecordError } from "./retained-record-store.js";
/** Internal handler observation, never supplied by request JSON or inferred from logical work. */
export interface CallerPhysicalSnapshot {
  schemaVersion:1; source:"handler-owned-native-ledger"; cutoff:"locally-settled";
  stages:{acquisition:number;judge:number|null;producer:number|null};
  knownSubtotal:number; total:number|null; reservationsRefused:number;
  admission:{acquisition:"shared";judge:"shared"|"unknown"|"not-configured";producer:"shared"|"unknown"|"not-configured"};
  attempts:readonly {provider:string;phase:string;outcome:string}[];
}
export function validateCallerPhysical(v:unknown):asserts v is CallerPhysicalSnapshot{
  const x=v as CallerPhysicalSnapshot;
  const closed=(v:unknown,keys:string[]):boolean=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
  const count=(v:unknown):boolean=>Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=100000;
  if(!closed(x,['schemaVersion','source','cutoff','stages','knownSubtotal','total','reservationsRefused','admission','attempts'])||x.schemaVersion!==1||x.source!=='handler-owned-native-ledger'||x.cutoff!=='locally-settled'||!closed(x.stages,['acquisition','judge','producer'])||!closed(x.admission,['acquisition','judge','producer'])||!count(x.stages.acquisition)||!(x.stages.judge===null||count(x.stages.judge))||!(x.stages.producer===null||count(x.stages.producer))||!count(x.knownSubtotal)||!(x.total===null||count(x.total))||!count(x.reservationsRefused)||x.admission.acquisition!=='shared'||!['shared','unknown','not-configured'].includes(x.admission.judge)||!['shared','unknown','not-configured'].includes(x.admission.producer)||!Array.isArray(x.attempts)||x.attempts.length>48)throw new CorruptRecordError('Invalid bounded native physical observation.');
  for(const a of x.attempts)if(!closed(a,['provider','phase','outcome'])||[a.provider,a.phase,a.outcome].some(s=>typeof s!=='string'||s.length>128))throw new CorruptRecordError('Invalid safe attempt observation.');
  try { if(Buffer.byteLength(JSON.stringify(x))>16384)throw new CorruptRecordError('Invalid bounded native physical observation.'); }
  catch { throw new CorruptRecordError('Invalid bounded native physical observation.'); }
  const subtotal=x.stages.acquisition+(x.stages.judge??0)+(x.stages.producer??0);
  if(x.knownSubtotal!==subtotal||x.total!==null&&x.total!==subtotal)throw new CorruptRecordError('Inconsistent physical observation totals.');
  for(const stage of ['judge','producer'] as const){
    const stageCount=x.stages[stage], admission=x.admission[stage];
    if(admission==='not-configured' ? stageCount!==null&&stageCount!==0 : stageCount===null&&x.total!==null)
      throw new CorruptRecordError('Inconsistent physical observation totals.');
  }
}
