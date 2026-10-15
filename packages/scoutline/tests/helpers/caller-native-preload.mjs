// Synthetic public protocol fixtures only; every other HTTP route refuses.
globalThis.fetch = async (url, init) => {
  const target=String(url),body=JSON.parse(String(init?.body??'{}'));
  if(target==='https://api.tavily.com/search')return Response.json({results:[{url:'https://example.test/release',title:'Synthetic release',content:'Public release page'}]});
  if(target==='https://api.tavily.com/extract')return Response.json({results:(body.urls??[]).map(url=>({url,raw_content:'Example package version 1.2.3. License MIT. CSV export is supported.'})),failed_results:[]});
  if(target.startsWith('https://api.typesafe.ai/'))return Response.json({model:'jev-1.13.0',answers:Object.fromEntries(Object.keys(body.questions??{}).map(k=>[k,{type:'noul',noul:/[fc]$/.test(k)?0.01:0.99}])),usage:{input_tokens:2,output_tokens:1}});
  throw new Error('Unexpected synthetic HTTP route: '+target);
};
