import { appendFileSync } from 'node:fs';
const record = event => appendFileSync(process.env.REVIEW_TRACE, JSON.stringify(event)+'\n');
const content = process.env.REVIEW_CONTENT ?? 'ExampleApp release 2.4.0. License MIT applies to release 2.4.0. CSV export is supported.';
const asyncIterator = process.stdin[Symbol.asyncIterator].bind(process.stdin);
process.stdin[Symbol.asyncIterator] = function () {
  const iterator=asyncIterator();
  const next=iterator.next.bind(iterator);
  iterator.next=(...args)=>{record({event:'stdin-read-started'});return next(...args);};
  return iterator;
};
let nativeAttempts=0;
globalThis.fetch=async(url,init={})=>{
  const target=String(url);
  record({url:target,method:init.method??'GET'});
  if(process.env.REVIEW_REFUSE_HTTP==='1') throw new Error('HTTP forbidden for this operation');
  if(target==='https://api.typesafe.ai/v1/systemone') {
    if(process.env.REVIEW_HANG_JUDGE==='1') return new Promise((_resolve,reject)=>{
      init.signal?.addEventListener('abort',()=>{record({event:'native-abort'});reject(new DOMException('aborted','AbortError'));},{once:true});
    });
    if(process.env.REVIEW_JUDGE_RETRY==='1' && nativeAttempts++===0) return Response.json({}, {status:429,headers:{'retry-after':'0'}});
    const body=JSON.parse(init.body);
    record({event:'native-context',requestBytes:Buffer.byteLength(init.body),questions:Object.keys(body.questions??{})});
    return Response.json({model:'jev-1.13.0',answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'noul',noul:/[fc]$/.test(k)?0.05:0.95}])),usage:{input_tokens:13,output_tokens:2}});
  }
  if(target==='https://api.tavily.com/search') return Response.json({results:[{title:'ExampleApp release',url:'https://example.test/release',content}]});
  if(target==='https://api.tavily.com/extract') {
    const body=JSON.parse(init.body);
    return Response.json({results:(body.urls??['https://example.test/release']).map(url=>({url,raw_content:content})),failed_results:[]});
  }
  throw new Error(`Unexpected HTTP blocked: ${target}`);
};
