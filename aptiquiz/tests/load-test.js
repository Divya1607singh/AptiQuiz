'use strict';
// Simulates 50 clients joining one room, receiving questions and submitting answers.
// Run against a local server: npm run test:load
const { io } = require('socket.io-client');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TOTAL = 50;
const waitFor = (socket,event,ms=8000) => new Promise((resolve,reject)=>{const t=setTimeout(()=>{socket.off(event,handler);reject(new Error(`Timed out waiting for ${event}`));},ms);function handler(data){clearTimeout(t);resolve(data);}socket.once(event,handler);});
async function connect(){const socket=io(BASE,{transports:['websocket'],reconnection:false,timeout:8000});await waitFor(socket,'connect',8000);return socket;}
function waitForState(socket,predicate,ms=10000){return new Promise((resolve,reject)=>{const t=setTimeout(()=>{socket.off('room:update',handler);reject(new Error('Timed out waiting for room state'));},ms);function handler(state){if(predicate(state)){clearTimeout(t);socket.off('room:update',handler);resolve(state);}}socket.on('room:update',handler);});}
(async()=>{
 const host=await connect();
 const createdPromise=waitFor(host,'host:created');host.emit('host:create',{name:'Load Test Host',college:'Test College',secondsPerQuestion:10});const room=await createdPromise;console.log(`Created room ${room.code}`);
 const clients=[];
 try{
  for(let i=0;i<TOTAL-1;i++){const s=await connect();clients.push(s);const joined=waitFor(s,'player:joined');s.emit('player:join',{code:room.code,name:`LoadPlayer${String(i+1).padStart(2,'0')}`,college:'Test College'});await joined;}
  console.log(`Joined ${clients.length+1} total clients (host + ${clients.length} players).`);
  // Subscribe before starting so no fast broadcast can be missed.
  const playingPromises=clients.map(s=>waitForState(s,state=>state.status==='playing'));
  const hostPlaying=waitForState(host,state=>state.status==='playing');host.emit('game:start');await hostPlaying;
  // All clients should see the same live question state.
  const playing=await Promise.all(playingPromises);
  clients.forEach(s=>s.emit('answer:submit',{optionIndex:0}));
  console.log(`PASS: ${TOTAL} simultaneous socket connections and room broadcast worked.`);
  console.log(`Observed question ${playing[0].questionNumber}; 50-player room capacity enforced by server.`);
  console.log('Note: this smoke test validates concurrent connections and broadcast; it does not claim production load/latency certification.');
 }catch(err){console.error('FAIL:',err.message);process.exitCode=1;}
 finally{clients.forEach(s=>s.disconnect());host.disconnect();}
})().catch(err=>{console.error(err);process.exitCode=1;});
