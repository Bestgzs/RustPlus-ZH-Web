const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const base=__dirname,url='http://127.0.0.1:3210';const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function status(){try{const r=await fetch(url+'/api/state',{signal:AbortSignal.timeout(1200)});const j=await r.json();return j.appId==='rustplus-zh-web'?j:null;}catch{return null;}}
async function main(){
 let s=await status();
 if(process.argv.includes('--stop')){
  if(!s){console.log('Service is already stopped.');return;}
  const r=await fetch(url+'/api/shutdown',{method:'POST',headers:{Origin:url,'X-CSRF-Token':s.csrf,'Content-Type':'application/json'},body:'{}'});
  if(!r.ok)throw Error('Could not stop service.');
  for(let i=0;i<30;i++){await wait(100);if(!await status()){console.log('Service stopped.');return;}}throw Error('Service did not stop in time.');
 }
 if(!s){
  const data=path.join(base,'data');fs.mkdirSync(data,{recursive:true});
  const out=fs.openSync(path.join(data,'service.log'),'a'),err=fs.openSync(path.join(data,'service-error.log'),'a');
  const child=spawn(process.execPath,[path.join(base,'server.cjs')],{cwd:base,detached:true,windowsHide:true,stdio:['ignore',out,err]});
  child.unref();fs.closeSync(out);fs.closeSync(err);
  for(let i=0;i<50;i++){await wait(200);s=await status();if(s)break;}
  if(!s)throw Error('Cannot start on port 3210. See data/service-error.log.');
 }
 console.log('Rust+ Chinese web assistant: '+url);
 if(!process.argv.includes('--no-browser')){
  const open=spawn(process.env.ComSpec||'cmd.exe',['/d','/c','start','',url],{windowsHide:true,detached:true,stdio:'ignore'});open.unref();
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
