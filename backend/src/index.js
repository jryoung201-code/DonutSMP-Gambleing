import express from "express";
import crypto from "node:crypto";
const app=express(); app.use(express.json({limit:"32kb"}));
const PORT=Number(process.env.PORT||10000);
const sessions=new Map(), txs=new Map(), balances=new Map();
const CONFIG={minimumBet:500000n,maximumBet:2000000n,paymentTarget:process.env.PAYMENT_TARGET||"VoduDoll_YT",enabledGames:["50_50","wheel","crates","horseRacing","45_45_10","oddEven"],showOdds:process.env.SHOW_ODDS==="true",cratePrices:{basic:20000n,rare:200000n,legendary:30000000n}};
const crates={
basic:[["coal","Coal (Stack)","minecraft:coal",64,6000,"common"],["iron_ingot","Iron Ingot","minecraft:iron_ingot",1,250,"common"],["ender_pearl","Ender Pearl (Stack)","minecraft:ender_pearl",16,2500,"common"],["diamond","Diamond","minecraft:diamond",1,2500,"uncommon"],["emerald_block","Emerald Block","minecraft:emerald_block",1,4500,"rare"],["netherite_scrap","Netherite Scrap","minecraft:netherite_scrap",1,1000000,"jackpot"]],
rare:[["gold_block","Gold Block","minecraft:gold_block",1,20000,"common"],["diamond_block","Diamond Block","minecraft:diamond_block",1,22500,"common"],["emerald_block_stack","Emerald Block (Stack)","minecraft:emerald_block",64,300000,"rare"],["ancient_debris","Ancient Debris","minecraft:ancient_debris",1,1000000,"epic"],["netherite_ingot","Netherite Ingot","minecraft:netherite_ingot",1,4500000,"jackpot"],["shulker_shell_stack","Shulker Shell (Stack)","minecraft:shulker_shell",64,51200,"uncommon"]],
legendary:[["netherite_ingot_stack","Netherite Ingot (Stack)","minecraft:netherite_ingot",64,300000000,"jackpot"],["netherite_block","Netherite Block","minecraft:netherite_block",1,40000000,"epic"],["elytra","Elytra","minecraft:elytra",1,320000000,"jackpot"],["totem","Totem of Undying","minecraft:totem_of_undying",1,15000,"common"],["golden_apple_stack","Golden Apple (Stack)","minecraft:golden_apple",64,64000,"uncommon"],["enchanted_golden_apple","Enchanted Golden Apple","minecraft:enchanted_golden_apple",1,500000,"rare"],["dragon_head","Dragon Head","minecraft:dragon_head",1,56900000,"epic"]]};
const weights={basic:[5000,3000,1400,500,99,1],rare:[4200,3000,1300,800,20,680],legendary:[5000,1500,900,300,150,80,2]};
const safe=v=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==="bigint"?Number(x):x));
const uuid=v=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function rnd(n){const lim=Math.floor(0x100000000/n)*n;for(;;){const x=crypto.randomBytes(4).readUInt32BE(0);if(x<lim)return x%n;}}
function weighted(ws){let r=rnd(ws.reduce((a,b)=>a+b,0));for(let i=0;i<ws.length;i++){if(r<ws[i])return i;r-=ws[i];}return ws.length-1;}
function auth(req){const h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return null;const s=sessions.get(h.slice(7));return s&&s.exp>Date.now()?s:null;}
app.get("/health",(q,r)=>r.json({ok:true}));
app.post("/api/auth/challenge",(q,r)=>{const id=crypto.randomBytes(24).toString("base64url");sessions.set("c:"+id,{exp:Date.now()+60000});r.json({serverId:id});});
app.post("/api/auth/login",async(q,r)=>{
  const {username,serverId}=q.body||{};
  const c=sessions.get("c:"+serverId);
  if(!c||c.exp<Date.now()||typeof username!=="string"||!username) return r.status(401).json({accepted:false,code:"UNAUTHENTICATED",reason:"Valid challenge and username required"});
  try{
    const u="https://sessionserver.mojang.com/session/minecraft/hasJoined?username="+encodeURIComponent(username)+"&serverId="+encodeURIComponent(serverId);
    const mr=await fetch(u);
    if(!mr.ok) return r.status(401).json({accepted:false,code:"UNAUTHENTICATED",reason:"Mojang session verification failed"});
    const profile=await mr.json();
    const verifiedUuid=profile.id ? profile.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,"$1-$2-$3-$4-$5") : null;
    if(!uuid(verifiedUuid)) return r.status(401).json({accepted:false,code:"UNAUTHENTICATED",reason:"Mojang did not verify this session"});
    sessions.delete("c:"+serverId);
    const t=crypto.randomBytes(32).toString("base64url");
    sessions.set(t,{uuid:verifiedUuid,username:profile.name||username,exp:Date.now()+900000});
    r.json({token:t,expiresInSeconds:900});
  }catch(e){console.error(e);r.status(502).json({accepted:false,code:"UNAUTHENTICATED",reason:"Mojang verification unavailable"});}
});
app.get("/api/config",(q,r)=>{const o=safe({minimumBet:CONFIG.minimumBet,maximumBet:CONFIG.maximumBet,paymentTarget:CONFIG.paymentTarget,enabledGames:CONFIG.enabledGames,showOdds:CONFIG.showOdds,cratePrices:CONFIG.cratePrices});if(CONFIG.showOdds)o.oddsBasisPoints={"50_50":{WIN:4000,LOSE:6000}};r.json(o);});
app.post("/api/bet",(req,res)=>{
 const s=auth(req), {transactionId,game,bet,selection=null}=req.body||{};
 if(!s)return res.status(401).json({accepted:false,transactionId,code:"UNAUTHENTICATED"});
 if(!uuid(transactionId))return res.status(400).json({accepted:false,transactionId,code:"INVALID_TRANSACTION_ID"});
 if(!CONFIG.enabledGames.includes(game))return res.status(400).json({accepted:false,transactionId,code:"GAME_DISABLED"});
 if(!Number.isSafeInteger(bet)||bet<0)return res.status(400).json({accepted:false,transactionId,code:"ABOVE_MAXIMUM"});
 const crate=game==="crates", b=BigInt(bet);
 if(crate?bet!==0:b<CONFIG.minimumBet||b>CONFIG.maximumBet)return res.status(400).json({accepted:false,transactionId,code:b<CONFIG.minimumBet?"BELOW_MINIMUM":"ABOVE_MAXIMUM"});
 const legal={crates:["basic","rare","legendary"],oddEven:["odd","even"],horseRacing:["diamond","iron","gold"]};
 if((legal[game]||[]).length&&!legal[game].includes(selection))return res.status(400).json({accepted:false,transactionId,code:"INVALID_SELECTION"});
 const key=s.uuid+":"+transactionId, old=txs.get(key);
 if(old){if(old.game!==game||old.bet!==bet||old.selection!==selection)return res.status(409).json({accepted:false,transactionId,code:"TRANSACTION_CONFLICT"});return res.json({...old.response,replayed:true});}
 const bal=balances.get(s.uuid)||0n, cost=crate?CONFIG.cratePrices[selection]:b;if(bal<cost)return res.status(400).json({accepted:false,transactionId,code:"INSUFFICIENT_BALANCE"});
 let result="LOSE",payout=0n,detail={};
 if(game==="50_50"){result=rnd(10000)<4000?"WIN":"LOSE";if(result==="WIN")payout=b*2n;}
 else if(game==="45_45_10"){const x=rnd(100);if(x<5){result="JACKPOT";payout=b*5n}else if(x<40){result="WIN";payout=b*2n}}
 else if(game==="oddEven"){const win=rnd(10000)<3000;let n;do n=1+rnd(10);while(win?((n%2===0)!==(selection==="even")):((n%2===0)===(selection==="even")));detail={number:n,parity:n%2===0?"even":"odd"};result=win?"WIN":"LOSE";if(win)payout=b*2n;}
 else if(game==="wheel"){const c={"0x":9,"0.5x":6,"1x":4,"1.5x":3,"2x":2,"3x":1},a=[];for(const [x,n] of Object.entries(c))for(let i=0;i<n;i++)a.push(x);for(let i=a.length-1;i>0;i--){const j=rnd(i+1);[a[i],a[j]]=[a[j],a[i]];}const slot=rnd(25),m=a[slot];detail={layout:a,slot,multiplier:m};payout=m==="0x"?0n:m==="0.5x"?b/2n:m==="1x"?b:m==="1.5x"?b*3n/2n:m==="2x"?b*2n:b*3n;result=payout>0n?"WIN":"LOSE";}
 else if(game==="horseRacing"){const o=["diamond","iron","gold"];for(let i=2;i>0;i--){const j=rnd(i+1);[o[i],o[j]]=[o[j],o[i]];}detail={winner:o[0],finishOrder:o};result=selection===o[0]?"WIN":"LOSE";if(result==="WIN")payout=b*3n;}
 else if(game==="crates"){const rows=crates[selection],reward=rows[weighted(weights[selection])],ids=rows.map(x=>x[0]),reel=Array.from({length:70},()=>ids[weighted(weights[selection])]),slot=8+rnd(54);reel[slot]=reward[0];detail={crate:selection,items:Object.fromEntries(rows.map(x=>[x[0],{id:x[0],name:x[1],icon:x[2],count:x[3],value:x[4],rarity:x[5]}])),reel,slot,reward:reward[0]};result=reward[5]==="jackpot"?"JACKPOT":"WIN";payout=BigInt(reward[4]);}
 const nb=bal-cost+payout,response=safe({accepted:true,transactionId,result,bet:crate?0:bet,payout,balance:nb,replayed:false,detail});balances.set(s.uuid,nb);txs.set(key,{game,bet,selection,response});res.json(response);
});
app.listen(PORT,"0.0.0.0",()=>console.log("DonutSMP backend on "+PORT));