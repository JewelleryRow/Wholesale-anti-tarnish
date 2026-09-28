window.onerror=function(msg,src,line,col,err){
  alert('⚠️ JS ERROR:\n'+msg+'\n(line '+line+')\n\nYe screenshot/text mujhe bhej dein.');
  return false;
};
if(typeof firebase==='undefined'){
  alert('⚠️ Firebase library load hi nahi hui! Internet slow hai ya koi ad-blocker/firewall gstatic.com ko block kar raha hai. Page reload karein ya doosra network try karein.');
} else if(typeof db==='undefined'){
  alert('⚠️ Firebase "db" object nahi bana — index.html ka Firebase config script check karein.');
}

const DEFAULT_UPI_ID="BHARATPE2P0T0H6Z3E05213@unitype";
const MAX_PHOTOS=4;
let photos=[];
let editingId=null;
let inventory=[];
let orders=[];
let categories=[];
let settings={codEnabled:true,shippingCost:40,minOrderValue:300,freeShipAbove:1000,prepaidDiscount:5,upiId:DEFAULT_UPI_ID};

function show(id,b){document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));document.getElementById(id).classList.add('active');document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active')}
const drop=document.getElementById('drop');drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag')};drop.ondragleave=()=>drop.classList.remove('drag');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');readFiles(e.dataTransfer.files)};document.getElementById('photo').onchange=e=>{readFiles(e.target.files);e.target.value='';};
/* Photo ko canvas se resize + compress karke chhota banate hain, taaki
   Realtime Database mein raw 3-5MB camera photo ki jagah ~100-200KB
   ka compact JPEG save ho — isi wajah se ab tak reload itna slow tha. */
function compressImage(file,maxDim=1000,quality=0.72){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        let{width,height}=img;
        if(width>height&&width>maxDim){height=Math.round(height*maxDim/width);width=maxDim}
        else if(height>maxDim){width=Math.round(width*maxDim/height);height=maxDim}
        const canvas=document.createElement('canvas');
        canvas.width=width;canvas.height=height;
        canvas.getContext('2d').drawImage(img,0,0,width,height);
        resolve(canvas.toDataURL('image/jpeg',quality));
      };
      img.onerror=()=>reject(new Error('Image decode fail'));
      img.src=reader.result;
    };
    reader.onerror=()=>reject(new Error('File read fail'));
    reader.readAsDataURL(file);
  });
}
/* Ek chhoti "thumb" (list-view ke liye) banata hai kisi bhi already-
   compressed data URL se — ye Storefront ki listing ko fast rakhne ke
   liye hai (neeche is file mein poora explanation hai ki kyun). */
function shrinkDataUrl(dataUrl,maxDim=360,quality=0.55){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      let{width,height}=img;
      if(width>height&&width>maxDim){height=Math.round(height*maxDim/width);width=maxDim}
      else if(height>maxDim){width=Math.round(width*maxDim/height);height=maxDim}
      const canvas=document.createElement('canvas');
      canvas.width=width;canvas.height=height;
      canvas.getContext('2d').drawImage(img,0,0,width,height);
      resolve(canvas.toDataURL('image/jpeg',quality));
    };
    img.onerror=()=>reject(new Error('Thumbnail decode fail'));
    img.src=dataUrl;
  });
}
function readFiles(fileList){
  const files=[...fileList].filter(f=>f&&f.type.startsWith('image/'));
  if(!files.length)return;
  const room=MAX_PHOTOS-photos.length;
  if(room<=0){alert(`Ek product mein zyada se zyada ${MAX_PHOTOS} photos ja sakti hain`);return;}
  if(files.length>room)alert(`Sirf ${room} aur photo(s) add ho sakti thi — limit ${MAX_PHOTOS} hai`);
  files.slice(0,room).forEach(f=>{
    compressImage(f).then(dataUrl=>{
      photos.push(dataUrl);
      renderPhotoView();
    }).catch(()=>{
      alert('⚠️ Ye photo process nahi ho payi, dobara try karein.');
    });
  });
}
function removePhoto(i){photos.splice(i,1);renderPhotoView()}
function renderPhotoView(){
  document.getElementById('photoView').innerHTML=photos.map((p,i)=>`<div class="photo-thumb"><img src="${p}"><button type="button" title="Remove" onclick="removePhoto(${i})">×</button></div>`).join('');
}

/* ===== Categories: live via Firebase — Admin adds a category once,
   it shows up in the "Category" dropdown here AND on the Storefront
   nav bar instantly, on all devices. ===== */
const DEFAULT_CATEGORIES=['Tools','Beads','Chain','Stone'];
let categoriesSeeded=false;
db.ref('categories').on('value',snap=>{
  const val=snap.val()||{};
  categories=Object.keys(val).map(k=>val[k]).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  if(!categories.length && !categoriesSeeded){
    categoriesSeeded=true;
    DEFAULT_CATEGORIES.forEach(name=>{
      const id='cat-'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
      db.ref('categories/'+id).set({id,name}).catch(err=>alert('⚠️ Default category seed fail: '+err.message));
    });
    return; // the seed write will re-trigger this listener with real data
  }
  renderCategoryOptions();
  renderInventory();
},err=>{
  alert('⚠️ Categories READ hi fail ho rahi hai:\n'+err.message+'\n\nFirebase Rules mein "categories" path par READ allow nahi hai.');
});
function renderCategoryOptions(){
  const sel=document.getElementById('category');
  if(!sel)return;
  const current=sel.value;
  sel.innerHTML='<option value="all">All</option>'+categories.map(c=>`<option value="${c.name}">${c.name}</option>`).join('');
  if([...sel.options].some(o=>o.value===current)) sel.value=current;
  const chips=document.getElementById('categoryChips');
  if(chips) chips.innerHTML=categories.map(c=>`<span class="chip">${c.name}<button type="button" title="Delete category" onclick="deleteCategory('${c.id}')">×</button></span>`).join('');
}
function addCategory(){
  const name=(prompt('Naye category ka naam likhein (e.g. Earrings):')||'').trim();
  if(!name)return;
  if(categories.some(c=>c.name.toLowerCase()===name.toLowerCase())){alert('Ye category pehle se maujood hai');return;}
  const id='cat-'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'-'+Date.now();
  db.ref('categories/'+id).set({id,name}).then(()=>{
    const sel=document.getElementById('category');
    if(sel) sel.value=name; // pre-select the freshly added category
  }).catch(err=>{
    console.error('addCategory failed:',err);
    alert('Category add NAHI hui — Firebase error: '+err.message+'\n\nFirebase console me jaake Realtime Database > Rules check karein, "categories" path par write allowed hona chahiye.');
  });
}
function deleteCategory(id){
  if(!confirm('Ye category delete karein? Isse pehle se assigned products ki category nahi badlegi.'))return;
  db.ref('categories/'+id).remove().catch(err=>{
    console.error('deleteCategory failed:',err);
    alert('Category delete NAHI hui — Firebase error: '+err.message+'\n\nFirebase console me jaake Realtime Database > Rules check karein, "categories" path par write/delete allowed hona chahiye.');
  });
}

/* ===== Inventory: live via Firebase — Admin adds/edits/deletes,
   Storefront reflects instantly. Each product can carry up to
   MAX_PHOTOS photos; the first one is used as the main/cover photo.

   IMPORTANT — data split for SPEED (no paid Firebase Storage needed):
   Photos are compressed JPEGs saved as base64 text right here in the
   Realtime Database (Storage is intentionally NOT used). But the
   Storefront's home/listing page only ever shows ONE small photo per
   product card — downloading all 4 full photos for every product just
   to show a listing thumbnail is what was making the customer app feel
   frozen/slow. So we now save two things per product:
     - inventory/{id}        → light fields only (title, price, category,
                                rating) + a small "thumb" (one shrunk
                                photo) — this is what the Storefront's
                                home page subscribes to, so it loads fast.
     - inventoryPhotos/{id}  → the full-size photo gallery (all photos) —
                                only fetched by the Storefront when a
                                customer actually opens that product's
                                detail page.
   Admin's own product list/edit form still shows/uses the full gallery
   as before; only the Storefront listing got lighter. ===== */
async function addProduct(){
  let title=document.getElementById('title').value.trim(),
      price=Number(document.getElementById('price').value),
      category=document.getElementById('category').value||'all',
      rating=document.getElementById('rating').value===''?0:Number(document.getElementById('rating').value),
      ratingCount=document.getElementById('ratingCount').value===''?0:Number(document.getElementById('ratingCount').value);
  if(!photos.length||!title||!price)return alert('Kam se kam 1 Photo, Title aur Price zaroori hai');
  if(rating<0||rating>5)return alert('Rating 0 se 5 ke beech honi chahiye');
  if(ratingCount<0)return alert('Rating Count negative nahi ho sakti');
  const id=editingId||('jr-'+Date.now());
  const saveBtn=document.getElementById('saveBtn');
  const prevText=saveBtn.textContent;
  saveBtn.disabled=true;
  saveBtn.textContent='Save Ho Raha Hai...';
  try{
    // Photos Firebase Storage par upload NAHI hoti (Storage jaan-bujh kar
    // istemal nahi kiya ja raha) — compressed photo seedha Realtime
    // Database mein base64 ki tarah save hoti hai.
    const finalPhotos=photos;
    const thumb=await shrinkDataUrl(finalPhotos[0]);
    // Pehle bhaari gallery save karo, taaki 'inventory' entry (jo
    // Storefront ko turant dikhta hai) tabhi likhe jab uski photo gallery
    // already maujood ho — koi race condition/missing-photo na aaye.
    await db.ref('inventoryPhotos/'+id).set({photos:finalPhotos});
    await db.ref('inventory/'+id).set({id,thumb,title,price,category,rating,ratingCount});
    saveBtn.disabled=false;
    resetInventoryForm();
  }catch(err){
    console.error('addProduct failed:',err);
    alert('⚠️ Product save NAHI hua — Database error: '+err.message+'\n\nFirebase console me jaake Realtime Database > Rules check karein, "inventory" aur "inventoryPhotos" path par write allowed hona chahiye.');
    saveBtn.disabled=false;
    saveBtn.textContent=prevText;
  }
}
function editProduct(id){
  const p=inventory.find(x=>x.id===id);
  if(!p)return;
  editingId=id;
  // Jab tak poori gallery load nahi hoti, form mein turant thumb (ya
  // purane products ke liye purana photo/photos field) dikha dete hain.
  photos=p.thumb?[p.thumb]:((p.photos&&p.photos.length)?[...p.photos]:(p.photo?[p.photo]:[]));
  renderPhotoView();
  document.getElementById('title').value=p.title||'';
  document.getElementById('price').value=p.price||'';
  document.getElementById('category').value=p.category||'all';
  document.getElementById('rating').value=p.rating||'';
  document.getElementById('ratingCount').value=p.ratingCount||'';
  document.getElementById('inventoryFormTitle').textContent='Edit Inventory';
  document.getElementById('saveBtn').textContent='Update Inventory';
  document.getElementById('cancelEditBtn').style.display='inline-block';
  show('inventory',document.querySelector('.nav button[onclick*="inventory"]'));
  window.scrollTo({top:0,behavior:'smooth'});
  // Poori gallery background mein laa kar form mein swap kar dete hain
  // (agar available ho) — taaki edit karte waqt saari purani photos dikhein.
  db.ref('inventoryPhotos/'+id).once('value').then(snap=>{
    if(editingId!==id)return; // user ne edit cancel/switch kar diya
    const val=snap.val();
    if(val&&val.photos&&val.photos.length){
      photos=[...val.photos];
      renderPhotoView();
    }
  }).catch(err=>console.error('Failed to load full gallery for edit:',err));
}
function cancelEdit(){ resetInventoryForm(); }
function resetInventoryForm(){
  editingId=null;
  photos=[];
  renderPhotoView();
  document.getElementById('title').value='';
  document.getElementById('price').value='';
  document.getElementById('category').value='all';
  document.getElementById('rating').value='';
  document.getElementById('ratingCount').value='';
  document.getElementById('inventoryFormTitle').textContent='Add Inventory';
  document.getElementById('saveBtn').textContent='Save Inventory';
  document.getElementById('cancelEditBtn').style.display='none';
}
function deleteProduct(id){
  if(!confirm('Ye product delete karein?'))return;
  db.ref('inventory/'+id).remove().then(()=>{
    db.ref('inventoryPhotos/'+id).remove().catch(()=>{}); // gallery bhi saaf kar do
    if(editingId===id)resetInventoryForm();
  }).catch(err=>{
    console.error('deleteProduct failed:',err);
    alert('⚠️ Product delete NAHI hua — Firebase error: '+err.message);
  });
}


db.ref('inventory').on('value',snap=>{
  const val=snap.val()||{};
  inventory=Object.keys(val).map(k=>val[k]).sort((a,b)=>String(b.id).localeCompare(String(a.id)));
  renderInventory();
});
function renderInventory(){
  document.getElementById('inventoryRows').innerHTML=inventory.length?inventory.map(p=>{
    const imgs=p.thumb?[p.thumb]:((p.photos&&p.photos.length)?p.photos:(p.photo?[p.photo]:[]));
    const thumbHtml=imgs.length?`<div class="pic-multi">${imgs.slice(0,3).map(src=>`<img src="${src}">`).join('')}</div>`:'';
    return `<tr><td>${thumbHtml}</td><td>${p.title}</td><td>${p.category||'all'}</td><td>₹${Number(p.price).toLocaleString('en-IN')}</td><td>${p.rating?`⭐ ${p.rating} (${p.ratingCount||0})`:'—'}</td><td><button class="edit-btn" onclick="editProduct('${p.id}')">Edit</button><button class="danger" onclick="deleteProduct('${p.id}')">Delete</button></td></tr>`;
  }).join(''):'<tr><td colspan="6">No inventory products</td></tr>';
  document.getElementById('productCount').textContent=inventory.length;
}

/* ===== Settings: live via Firebase — same status the Storefront reads ===== */
function toggleCOD(){ db.ref('settings').update({codEnabled:!settings.codEnabled}); }
function saveSettings(){
  const upi=document.getElementById('upiId').value.trim();
  if(!upi)return alert('UPI ID khaali nahi ho sakti');
  db.ref('settings').update({
    upiId:upi,
    shippingCost:Number(document.getElementById('shipping').value||0),
    minOrderValue:Number(document.getElementById('minimum').value||0),
    freeShipAbove:Number(document.getElementById('freeShipAbove').value||0),
    prepaidDiscount:Number(document.getElementById('prepaidDiscount').value||0),
    ...timerUpdate()
  });
  alert('Settings saved');
}
/* ===== Discount Timer — admin hours/min/sec daalta hai, Save par
   "prepaidDiscountExpiresAt" (server-time ms) ban jaata hai. Storefront usi
   time tak discount deta hai; time khatam => discount 0. Sab 0 = no timer. ===== */
let _serverOffset=0;
db.ref('.info/serverTimeOffset').on('value',s=>{_serverOffset=Number(s.val())||0;});
function serverNow(){return Date.now()+_serverOffset;}
function timerUpdate(){
  const h=Number(document.getElementById('discHours').value||0),
        m=Number(document.getElementById('discMinutes').value||0),
        sec=Number(document.getElementById('discSeconds').value||0);
  const total=(h*3600+m*60+sec)*1000;
  // Sab 0 hai: agar pehle se timer chal raha hai to usse na chhedo, warna no-timer.
  if(total<=0)return (settings.prepaidDiscountExpiresAt>serverNow())?{}:{prepaidDiscountExpiresAt:0};
  return {prepaidDiscountExpiresAt:serverNow()+total};
}
function stopDiscountTimer(){
  if(!confirm('Timer hata dein? Discount bina timer ke chalta rahega (ya 0 % rakhein to band).'))return;
  db.ref('settings').update({prepaidDiscountExpiresAt:0});
  ['discHours','discMinutes','discSeconds'].forEach(id=>document.getElementById(id).value=0);
}
function fmtLeft(ms){const t=Math.max(0,Math.floor(ms/1000));return String(Math.floor(t/3600)).padStart(2,'0')+':'+String(Math.floor(t%3600/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');}
function renderDiscountTimerStatus(){
  const el=document.getElementById('discountTimerStatus');if(!el)return;
  const exp=Number(settings.prepaidDiscountExpiresAt)||0;
  if(!exp){el.textContent='No timer — discount hamesha chalu';el.style.color='#555';}
  else if(serverNow()<exp){el.textContent='⏳ Discount chalu — khatam hone mein: '+fmtLeft(exp-serverNow());el.style.color='#1a7a3c';}
  else{el.textContent='❌ Offer khatam — discount ab 0 hai';el.style.color='#c22';}
}
setInterval(renderDiscountTimerStatus,1000);
db.ref('settings').on('value',snap=>{
  settings={codEnabled:true,shippingCost:40,minOrderValue:300,freeShipAbove:1000,prepaidDiscount:5,upiId:DEFAULT_UPI_ID,...(snap.val()||{})};
  syncSettingsUI();
  renderDiscountTimerStatus();
});
function syncSettingsUI(){document.getElementById('codToggle').classList.toggle('on',!!settings.codEnabled);document.getElementById('shipping').value=settings.shippingCost??40;document.getElementById('minimum').value=settings.minOrderValue??300;document.getElementById('freeShipAbove').value=settings.freeShipAbove??1000;document.getElementById('prepaidDiscount').value=settings.prepaidDiscount??5;document.getElementById('upiId').value=settings.upiId??DEFAULT_UPI_ID}

/* ===== Orders: live via Firebase — Customer places, Admin updates status,
   Customer sees the new status instantly. Status keys match the storefront's
   tracking stages exactly. ===== */
const STATUS_KEYS=['PLACED','CONFIRMED','READY_TO_SHIP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','RTO','REJECTED','CANCELLED'];
function statuses(o){return STATUS_KEYS.map(s=>`<option value="${s}" ${o.status===s?'selected':''}>${s.replaceAll('_',' ')}</option>`).join('')}
function updateStatus(id,v){
  const o=orders.find(x=>x.id===id);
  const now=Date.now();
  const entry={status:v,at:now,label:v.replaceAll('_',' ')};
  const history=(o&&o.history)?[...o.history,entry]:[entry];
  db.ref('orders/'+id).update({status:v,updatedAt:now,history});
}
/* Customer card par "Accept Order" button isi ko call karta hai —
   order PLACED se CONFIRMED ho jaata hai, aur turant Orders page ke
   "Accepted / In-Progress" section mein chala jaata hai. */
function acceptOrder(id){ updateStatus(id,'CONFIRMED'); }

/* ===== Lifetime per-customer order count — "customerStats" ek ALAG
   Firebase path hai jo "orders" se kabhi delete nahi hota. Jab bhi koi
   naya order aata hai, us customer ke phone ke neeche uski order-id
   permanently record ho jaati hai. Isse "Clear All Orders" chalane ke
   baad bhi pata chalta rehta hai ki kaunsa customer REPEAT hai (2nd/3rd
   baar order kar chuka hai), chahe purane orders delete ho chuke ho. ===== */
let customerStats={};
db.ref('customerStats').on('value',snap=>{
  customerStats=snap.val()||{};
  renderCustomers();
});
db.ref('orders').on('child_added',snap=>{
  const o=snap.val()||{};
  const phone=String(o.customerPhone||(o.address&&o.address.phone)||'').trim();
  if(!phone)return;
  db.ref('customerStats/'+phone+'/orderIds/'+snap.key).set(true).catch(()=>{});
});
function lifetimeOrderCount(phone){
  const rec=phone&&customerStats[phone];
  return (rec&&rec.orderIds)?Object.keys(rec.orderIds).length:0;
}

/* "Saare Orders Clear Karein" button — sirf "orders" path delete karta
   hai, isliye Dashboard/Orders ke saare counters (Total Orders, Total
   Amount, Placed, Delivered) turant 0 ho jaate hain. "customerStats"
   ko yeh function kabhi nahi chhedta, isliye repeat-customer record
   surakshit rehta hai. */
function clearAllOrders(){
  if(!confirm('⚠️ Yeh SAARE orders hamesha ke liye delete kar dega — Total Orders, Total Amount, Placed aur Delivered, sab 0 ho jayenge. Customer ka "pehle order kiya tha" record surakshit rahega. Aage badhein?'))return;
  if(!confirm('Pakka pakka? Yeh action wapas nahi ho sakta.'))return;
  db.ref('orders').remove().then(()=>{
    alert('✅ Saare orders clear ho gaye — Dashboard aur Orders section ab 0 se shuru hoga.');
  }).catch(err=>{
    console.error('clearAllOrders failed:',err);
    alert('⚠️ Clear NAHI hua — Firebase error: '+err.message);
  });
}
db.ref('orders').on('value',snap=>{
  const val=snap.val()||{};
  orders=Object.keys(val).map(k=>val[k]).sort((a,b)=>(b.placedAt||0)-(a.placedAt||0));
  renderOrders();
  renderCustomers();
});
function orderCardHtml(o){
  const a=o.address||{},name=a.name||o.customerName||'Customer',phone=o.customerPhone||a.phone||'';
  const addr=[a.address,a.city,a.state,a.pincode].filter(Boolean).join(', ')||'Address nahi hai';
  const items=o.items||[];
  const itemsHtml=items.length?items.map(i=>`<div class="jr-item-box"><b>${i.n||i.name}</b><span>× ${i.qty}</span></div>`).join(''):'<span class="small">Koi item nahi</span>';
  const total=o.total??o.totalAmount??0;
  const isDelivered=String(o.status||'').toUpperCase()==='DELIVERED';
  const isCancelled=String(o.status||'').toUpperCase()==='CANCELLED';
  const cancelBlockHtml=isCancelled?`
    <div class="jr-block jr-pending" style="border-top:2px solid #171717">
      <div class="jr-block-title">❌ Cancelled — Refund Details</div>
      <div style="margin-bottom:6px;font-size:13px">Cancelled on: <b>${o.cancelledAt?new Date(o.cancelledAt).toLocaleString('en-IN'):'-'}</b></div>
      <div style="margin-bottom:6px;font-size:13px">Payment: <b>${o.payment||'-'}</b> • Amount: <b>₹${Number(total).toLocaleString('en-IN')}</b></div>
      <div style="margin-bottom:6px;font-size:13px">Refund UPI ID: <b id="rf-${o.id}">${o.refundUpiId||'Not provided'}</b> ${o.refundUpiId?`<button type="button" class="edit-btn" onclick="navigator.clipboard&&navigator.clipboard.writeText('${o.refundUpiId}');this.textContent='Copied'">Copy</button>`:''}</div>
      <div style="font-size:13px">${o.refundStatus||'Refund pending'}</div>
    </div>`:'';
  return `<div class="jr-card">
    <div class="jr-card-header">
      <div><div class="jrh-title">🧾 <span>${o.id||'-'}</span></div><div class="jrh-sub">👤 ${name}${phone?` • 📞 ${phone}`:''}</div></div>
      <div class="jrh-right">Shipping: ₹${o.shipping??0}<br><span class="jrh-amount">₹${Number(total).toLocaleString('en-IN')}</span></div>
    </div>
    <div class="jr-card-address">📍 ${addr}</div>
    <div class="jr-card-body">
      <div class="jr-block jr-cart">
        <div class="jr-block-title">💍 Order Items</div>
        ${itemsHtml}
      </div>
      <div class="jr-block jr-value">
        <div class="jr-block-title">💳 Payment &amp; Status</div>
        <div style="margin-bottom:8px;font-size:13px">Payment: <b>${o.payment||'-'}</b></div>
        <select class="status" style="width:100%" onchange="updateStatus('${o.id}',this.value)">${statuses(o)}</select>
        ${isDelivered?'':`<button type="button" class="jr-deliver-btn" onclick="updateStatus('${o.id}','DELIVERED')">📦 Mark as Delivered</button>`}
      </div>
    </div>
    ${cancelBlockHtml}
  </div>`;
}
function renderOrders(){
  const acceptedBody=document.getElementById('acceptedOrders');
  const deliveredBody=document.getElementById('deliveredOrders');
  if(!acceptedBody||!deliveredBody)return;

  // PLACED (naye, abhi accept nahi hue) orders yahan nahi, Customers page
  // par us customer ke apne card mein dikhte hain — Accept karte hi yahan aa jaate hain.
  const accepted=orders.filter(o=>{
    const s=String(o.status||'').toUpperCase();
    return s!=='PLACED'&&s!=='DELIVERED';
  });
  const delivered=orders.filter(o=>String(o.status||'').toUpperCase()==='DELIVERED');

  acceptedBody.innerHTML=accepted.length?accepted.map(orderCardHtml).join(''):'<p style="text-align:center;padding:20px;color:#888">Abhi koi accepted order nahi hai</p>';
  deliveredBody.innerHTML=delivered.length?delivered.map(orderCardHtml).join(''):'<p style="text-align:center;padding:20px;color:#888">Abhi tak koi order deliver nahi hua</p>';

  const deliveredAmount=delivered.reduce((sum,o)=>sum+Number(o.total??o.totalAmount??0),0);
  document.getElementById('deliveredCount').textContent=delivered.length;
  document.getElementById('deliveredAmount').textContent='₹'+deliveredAmount.toLocaleString('en-IN');

  let total=orders.reduce((a,o)=>a+Number(o.total??o.totalAmount??0),0);
  document.getElementById('ordersCount').textContent=orders.length;
  document.getElementById('placedCount').textContent=orders.filter(o=>String(o.status||'').toUpperCase()==='PLACED').length;
  document.getElementById('totalAmount').textContent='₹'+total.toLocaleString('en-IN');
}

/* Manual refresh button just re-renders from the already-live in-memory data. */
function renderAll(){renderInventory();renderOrders();syncSettingsUI();renderCategoryOptions();renderCustomers();}

/* ===== Customers: live via Firebase — Storefront pushes a logged-in
   customer's profile + current cart here whenever they log in, edit
   their profile, or change their cart. Guests (not logged in) never
   appear here. ===== */
let customers=[];
db.ref('customers').on('value',snap=>{
  const val=snap.val()||{};
  customers=Object.keys(val).map(k=>val[k]).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  renderCustomers();
},err=>{
  console.error('customers read failed:',err);
});
function renderCustomers(){
  const body=document.getElementById('customerRows');
  if(!body)return;
  if(!customers.length){
    body.innerHTML='<p style="text-align:center;padding:20px;color:#888">Abhi tak koi customer login nahi hua</p>';
    return;
  }
  body.innerHTML=customers.map(c=>{
    const addr=[c.address,c.landmark,c.district,c.state,c.pincode].filter(Boolean).join(', ')||'Address nahi diya';
    const cartItems=(c.cart&&c.cart.length)?c.cart:[];
    const cartHtml=cartItems.length?cartItems.map(i=>`<div class="jr-item-box"><b>${i.n||i.name}</b><span>× ${i.qty}</span></div>`).join(''):'<span class="small">Cart khali hai</span>';
    const lastActive=c.updatedAt?new Date(c.updatedAt).toLocaleString('en-IN'):'—';

    // Is customer ke SAARE orders (koi bhi status — PLACED, CONFIRMED,
    // DELIVERED, ...), sabse naya sabse pehle. Pehle sirf PLACED order
    // hi yahan dikhta tha, isliye accept karte hi "kisne kya order
    // kiya" gayab ho jaata tha. Ab yahan hamesha us customer ka
    // sabse latest order + uska status saaf dikhega.
    const custOrders=orders.filter(o=>{
      const phone=o.customerPhone||(o.address&&o.address.phone)||'';
      return phone===c.phone;
    }).sort((a,b)=>(b.placedAt||b.updatedAt||0)-(a.placedAt||a.updatedAt||0));
    const latestOrder=custOrders[0];
    const lifetime=lifetimeOrderCount(c.phone);

    const rightBlock=latestOrder?(()=>{
      const items=latestOrder.items||[];
      const itemsHtml=items.length?items.map(i=>`<div class="jr-item-box"><b>${i.n||i.name}</b><span>× ${i.qty}</span></div>`).join(''):'<span class="small">Koi item nahi</span>';
      const total=latestOrder.total??latestOrder.totalAmount??0;
      const status=String(latestOrder.status||'PLACED').toUpperCase();
      const isPending=status==='PLACED';
      const blockClass=isPending?'jr-pending':'jr-value';
      const heading=isPending?'🧾 Naya Order Aaya Hai':`🧾 Latest Order — ${status.replaceAll('_',' ')}`;
      return `<div class="jr-block ${blockClass}">
          <div class="jr-block-title">${heading}</div>
          <div class="small" style="margin-bottom:8px">Order ID: ${latestOrder.id||'-'}</div>
          ${itemsHtml}
          <div class="jr-total-line">Total: ₹${Number(total).toLocaleString('en-IN')}</div>
          ${isPending?`<button type="button" class="jr-accept-btn" onclick="acceptOrder('${latestOrder.id}')">✅ Accept Order</button>`:''}
        </div>`;
    })():`<div class="jr-block jr-value">
          <div class="jr-block-title"> — Cart Value</div>
          <div class="jr-total-line">₹${Number(c.cartTotal||0).toLocaleString('en-IN')}</div>
        </div>`;

    return `<div class="jr-card">
      <div class="jr-card-header">
        <div><div class="jrh-title">${c.name||'Naam nahi diya'}${lifetime>1?' <span class="repeat-badge">🔁 Repeat Customer</span>':''}</div><div class="jrh-sub">📞 ${c.phone||'-'} • Lifetime Orders: ${lifetime}</div></div>
        <div class="jrh-right">Last Active<br>${lastActive}</div>
      </div>
      <div class="jr-card-address">📍 ${addr}</div>
      <div class="jr-card-body">
        <div class="jr-block jr-cart">
          <div class="jr-block-title">🛒 Current Cart</div>
          ${cartHtml}
        </div>
        ${rightBlock}
      </div>
    </div>`;
  }).join('');
}