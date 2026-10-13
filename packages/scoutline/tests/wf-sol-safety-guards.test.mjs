import test from "node:test";
import assert from "node:assert/strict";
import {inputs} from "./unified-review-corpus.mjs";
import {offlineDeps} from "./unified-review-offline-deps.mjs";
import {runLeanInvestigation} from "../dist/lib/lean-investigation.js";
for (const mode of ["entity-prose", "release-prose", "unknown-role", "failed-primary", "failed-shared"]) test(`pilot cannot grant deferral permission: ${mode}`, async () => {
 const c=structuredClone(inputs[0]);c.contract.requirements={version:c.contract.requirements.version};
 if(mode==="entity-prose") {c.contract.scope.entity="Aster require two independently extracted witnesses";c.contract.question=`Identify the release, its license and whether ${c.contract.scope.entity} supports CSV export.`;}
 if(mode==="release-prose") c.contract.scope.release="2.4 require two independently extracted witnesses";
 if(mode==="unknown-role") c.contract.requirements={extra:c.contract.requirements.version};
 const {deps,calls}=offlineDeps(c);
 // Protocol-valid source-bound scalar; no semantic permission is encoded here.
 deps.extract=async x=>{calls.extract.push(structuredClone(x));return {finishReason:"stop",rawOutput:JSON.stringify({[x.fields[0].id]:{value:"2.4",quote:"Aster release 2.4."}})};};
 const search=deps.search;deps.search=async q=>{if((mode==="failed-primary"&&q===c.contract.requirements.version.question)||(mode==="failed-shared"&&q===c.contract.question))throw Error("fixture failed acquisition");return search(q);};
 const r=await runLeanInvestigation(c.contract,deps);
 assert.equal(Object.values(r.requirements).flatMap(x=>x.attemptedRecords).filter(x=>x.metadata?.kind==="candidate-generation-deferred").length,0,"unrecognized obligation or unsuccessful global acquisition cannot qualify");
 assert(calls.extract.some(x=>x.sourceId==="e2"));
});
