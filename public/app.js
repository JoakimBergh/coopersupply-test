let {models,categories,products,engines,catalogMeta}=window.COOPER_SUPPLY;
window.COOPER_SHIPPING_DISPLAY_CENTS=0;
const categoryMap=Object.fromEntries(categories.map(([code,name])=>[code,name]));
const modelMap=Object.fromEntries(models.map(m=>[m.code,m]));
const esc=(v="")=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const money=n=>n==null?"Pris kommer":"kr "+Number(n).toLocaleString("nb-NO")+",-";
const displayPrice=p=>{const regular=p.price==null?null:Number(p.price);const sale=p.salePrice==null?null:Number(p.salePrice);if(sale!=null&&regular!=null&&sale>0&&sale<regular)return `<span class="salePrice"><del>${money(regular)}</del><strong>${money(sale)}</strong><em>SALG</em></span>`;return `<span class="regularPrice">${money(regular)}</span>`;};
const fuelLabel=f=>f==="Petrol"?"Bensin":f==="Diesel"?"Diesel":f==="All"?"Alle drivstoff":f;
const fuelListLabel=(arr=[])=>arr.map(fuelLabel).join(" / ");
const stockStatusMeta={own_stock:{label:"På lager",icon:"🟢",className:"own"},external_stock:{label:"På eksternt lager",icon:"🟠",className:"external"},out_of_stock:{label:"Ikke på lager",icon:"🔴",className:"out"}};
function stockStatusLabel(v){const m=stockStatusMeta[v]||stockStatusMeta.external_stock;return `${m.icon} ${m.label}`;}
function stockStatusClass(v){return (stockStatusMeta[v]||stockStatusMeta.external_stock).className;}
function stockStatusBadge(p){const status=p?.stockStatus||"external_stock";const m=stockStatusMeta[status]||stockStatusMeta.external_stock;return `<span class="stockStatus ${m.className}">${m.icon} ${m.label}</span>`;}
let activeProductFilter="all",activeModelFilter="all",activeCategoryFilter="all",activeVehicle=null,cart=[],visibleProductLimit=48;
const vehicleStorageKey="cooperSupply.vehicleProfile.v21";
const drivetrainLabel=v=>v==="ALL4"?"ALL4":"FWD";
const transmissionLabel=v=>v==="Automatic"?"Automat":v==="Manual"?"Manuell":v;

function renderCategories(){
  // Public category landing page was removed in ZV1.1; category filtering remains inside the shop.
  renderCategoryFilters();
}
function renderCategoryFilters(){
  const el=document.getElementById("categoryFilters");
  if(!el)return;
  el.innerHTML=`<button class="filter categoryFilter${activeCategoryFilter==="all"?" active":""}" data-category-filter="all">Alle kategorier</button>`+categories.map(([code,name])=>`<button class="filter categoryFilter${activeCategoryFilter===code?" active":""}" data-category-filter="${code}">${esc(name)}</button>`).join("");
}
function fillOptions(id, placeholder, values, disabled=false){
  const el=document.getElementById(id);
  if(!el)return;
  el.disabled=disabled;
  el.innerHTML=`<option value="">${placeholder}</option>`+values.map(v=>`<option value="${esc(v.value??v)}">${esc(v.label??v)}</option>`).join("");
}
function selectedModel(){return models.find(m=>m.code===document.getElementById("fitModel").value);}
function availableYears(m){return Array.from({length:m.years[1]-m.years[0]+1},(_,i)=>String(m.years[0]+i));}
// ZV7 fitment helpers. For a year range, return the union of every rule that
// overlaps the selected range. This deliberately does not infer undocumented fitment.
function yearOptions(entry,kind,year){
  return yearRangeOptions(entry,kind,Number(year),Number(year));
}
function yearRangeOptions(entry,kind,fromYear,toYear){
  if(!entry)return [];
  const from=Number(fromYear),to=Number(toYear);
  if(!Number.isFinite(from)||!Number.isFinite(to))return [];
  const lo=Math.min(from,to),hi=Math.max(from,to);
  const rules=entry?.[`${kind}Rules`];
  if(Array.isArray(rules)){
    const values=[];
    for(const rule of rules){
      if(rule.to>=lo&&rule.from<=hi)values.push(...rule.values);
    }
    return [...new Set(values)];
  }
  const field=kind==='transmission'?'transmissions':'drivetrains';
  return Array.isArray(entry?.[field])?[...new Set(entry[field])]:[];
}

// LCI/facelift thresholds used by the frontend when registration data is available.
// Production date is preferred; first registration is the fallback.
const lciStartYear={R50:2005,R53:2005,R55:2010,R56:2010,R57:2011,R60:2014,R61:2014};
function resolveLci(modelCode,{productionDate=null,firstRegistrationDate=null,year=null}={}){
  const threshold=lciStartYear[modelCode];
  if(!threshold)return null;
  const sourceDate=productionDate||firstRegistrationDate;
  if(sourceDate){
    const parsed=new Date(sourceDate);
    if(!Number.isNaN(parsed.getTime()))return parsed.getFullYear()>=threshold;
    const match=String(sourceDate).match(/(20\d{2})/);
    if(match)return Number(match[1])>=threshold;
  }
  if(Number.isFinite(Number(year)))return Number(year)>=threshold;
  return null;
}
function drivetrainOptions(entry,year){
  if(!entry)return [];
  const values=yearOptions(entry,'drivetrain',year);
  return (entry.model==='R60'||entry.model==='R61')?(values.length?values:['FWD']):['FWD'];
}
function transmissionOptions(entry,year){return yearOptions(entry,'transmission',year);}
function powerForYear(e,year){
  const y=Number(year);
  const rule=(e.powerRules||[]).find(r=>y>=r.from&&y<=r.to);
  return rule?.power??e.power;
}
const selectorVariantOrder = {
  "One D": 10,
  "Cooper D": 20,
  "Cooper SD": 30,
  "One": 40,
  "Cooper": 50,
  "Cooper S": 60,
  "JCW": 70,
  "GP1": 80,
  "GP2": 90
};
function availableEngines(model,year){
  if(!model||!year)return [];
  const y=Number(year);
  return engines
    .filter(e=>e.model===model.code&&y>=e.from&&y<=e.to)
    .sort((a,b)=>{
      const av=selectorVariantOrder[a.variant]??999;
      const bv=selectorVariantOrder[b.variant]??999;
      if(av!==bv)return av-bv;
      return String(a.id).localeCompare(String(b.id));
    })
    .map(e=>({value:e.id,label:`${e.variant} · ${fuelLabel(e.fuel)} · ${e.engine} · ${powerForYear(e,y)} HK`}));
}
function populateFitmentModel(){
  fillOptions("fitModel","Velg modell",models.map(m=>({value:m.code,label:`${m.code} — ${m.name}`})));
  fillOptions("fitYear","Velg år",[],true);
  fillOptions("fitEngine","Velg motor / variant",[],true);
  fillOptions("fitDrivetrain","Velg drivlinje",[],true);
  fillOptions("fitTransmission","Velg girkasse",[],true);
  hideConditionalFields();
}
function hideConditionalFields(){
  document.getElementById("drivetrainField")?.classList.add("hidden");
  document.getElementById("transmissionField")?.classList.add("hidden");
}
function resetVehicleOptions(){
  fillOptions("fitDrivetrain","Velg drivlinje",[],true);
  fillOptions("fitTransmission","Velg girkasse",[],true);
  hideConditionalFields();
}
function updateFitmentFields(){
  const m=selectedModel();
  if(!m){
    fillOptions("fitYear","Velg år",[],true);
    fillOptions("fitEngine","Velg motor / variant",[],true);
    resetVehicleOptions();
    document.getElementById("fitVehicleData").innerHTML="";
    return;
  }
  fillOptions("fitYear","Velg år",availableYears(m));
  fillOptions("fitEngine","Velg motor / variant",[],true);
  resetVehicleOptions();
  document.getElementById("fitVehicleData").innerHTML="";
}
function updateEngineFields(){
  const m=selectedModel(), year=document.getElementById("fitYear").value;
  fillOptions("fitEngine","Velg motor / variant",availableEngines(m,year));
  resetVehicleOptions();
  document.getElementById("fitVehicleData").innerHTML="";
}
function selectedEngine(){const id=document.getElementById("fitEngine").value;return engines.find(e=>e.id===id);}
function updateConditionalVehicleOptions(){
  const e=selectedEngine();
  const year=Number(document.getElementById("fitYear").value);
  resetVehicleOptions();
  if(!e||!year)return;
  const drivetrains=drivetrainOptions(e,year);
  const transmissions=transmissionOptions(e,year);
  fillOptions("fitDrivetrain","Velg drivlinje",drivetrains.map(v=>({value:v,label:drivetrainLabel(v)})),drivetrains.length<=1);
  fillOptions("fitTransmission","Velg girkasse",transmissions.map(v=>({value:v,label:transmissionLabel(v)})),transmissions.length<=1);
  if(drivetrains.length>1)document.getElementById("drivetrainField")?.classList.remove("hidden");
  if(transmissions.length>1)document.getElementById("transmissionField")?.classList.remove("hidden");
}
function currentDrivetrain(){
  const e=selectedEngine(),year=Number(document.getElementById("fitYear").value);
  if(!e||!year)return null;
  const options=drivetrainOptions(e,year);
  return options.length===1?options[0]:document.getElementById("fitDrivetrain").value||null;
}
function currentTransmission(){
  const e=selectedEngine(),year=Number(document.getElementById("fitYear").value);
  if(!e||!year)return null;
  const options=transmissionOptions(e,year);
  return options.length===1?options[0]:(options.length>1?document.getElementById("fitTransmission").value||null:null);
}
function buildVehicle(){
  const m=selectedModel(),e=selectedEngine(),year=Number(document.getElementById("fitYear").value);
  if(!m||!e||!year)return null;
  const drivetrain=currentDrivetrain(),transmission=currentTransmission();
  const needsDrivetrain=(m.code==="R60"||m.code==="R61")&&(e.drivetrains||["FWD"]).length>1;
  const needsTransmission=(e.transmissions||[]).length>1;
  if(needsDrivetrain&&!drivetrain)return null;
  if(needsTransmission&&!transmission)return null;
  return {model:m.code,year,body:m.bodyStyle,engineId:e.id,variant:e.variant,fuel:e.fuel,engine:e.engine,power:powerForYear(e,year),drivetrain:drivetrain||"FWD",transmission:transmission||null,lci:resolveLci(m.code,{year})};
}
function vehicleSummary(v){
  const parts=[`${v.model} · ${v.year}`,v.variant,`${fuelLabel(v.fuel)} · ${v.engine}`,`${v.power} HK`];
  if(v.drivetrain)parts.push(drivetrainLabel(v.drivetrain));
  if(v.transmission)parts.push(transmissionLabel(v.transmission));
  return parts.join(" · ");
}
function renderVehicleData(v){
  document.getElementById("fitVehicleData").innerHTML=`<div class="vehicleResult"><div><b>${esc(v.model)} · ${v.year}</b><span>${esc(v.body)}</span></div><div><b>${esc(v.variant)}</b><span>${esc(fuelLabel(v.fuel))} · ${esc(v.engine)}</span></div><div><b>${v.power} HK</b><span>${v.drivetrain?esc(drivetrainLabel(v.drivetrain)):""}${v.transmission?` · ${esc(transmissionLabel(v.transmission))}`:""}</span></div></div>`;
}
function clearVehicleSelection({scrollToTop=false}={}){
  activeVehicle=null;
  activeModelFilter="all";
  activeCategoryFilter="all";
  localStorage.removeItem(vehicleStorageKey);
  document.getElementById("fitModel").value="";
  updateFitmentFields();
  document.getElementById("fitVehicleData").innerHTML="";
  document.getElementById("manualFitment")?.classList.add("hidden");
  document.getElementById("manualFitmentToggle")?.setAttribute("aria-expanded","false");
  document.getElementById("resetFitment")?.classList.add("hidden");
  document.getElementById("fitmentStatus").textContent="";
  document.getElementById("fitmentSelection").textContent="Ingen MINI valgt";
  renderCategories();
  renderProducts();
  if(scrollToTop)window.scrollTo({top:0,behavior:"smooth"});
}
function valueMatches(ruleValue,actual){return !ruleValue?.length||ruleValue.includes("All")||ruleValue.includes(actual);}
function faceliftRuleMatches(rule,v){
  const ruleValue=rule.faceliftRule||"all";
  if(ruleValue==="all")return true;
  const lci=typeof v.lci==="boolean"?v.lci:resolveLci(v.model,{year:v.year});
  if(lci===null)return false;
  if(ruleValue.startsWith("lt:"))return lci===false;
  if(ruleValue.startsWith("gte:"))return lci===true;
  return true;
}
function ruleMatches(rule,v){
  if(!rule.models?.includes(v.model))return false;
  if(rule.yearFrom!=null&&v.year<rule.yearFrom)return false;
  if(rule.yearTo!=null&&v.year>rule.yearTo)return false;
  if(!faceliftRuleMatches(rule,v))return false;
  if(!valueMatches(rule.fuel,v.fuel))return false;
  if(rule.engines?.length&&!rule.engines.includes("All")&&!rule.engines.includes(v.engineId)&&!rule.engines.some(x=>x===v.engine||v.engine.includes(x)))return false;
  if(rule.variants?.length&&!rule.variants.includes("All")&&!rule.variants.includes(v.variant))return false;
  if(!valueMatches(rule.drivetrains,v.drivetrain))return false;
  if(!valueMatches(rule.transmissions,v.transmission))return false;
  return true;
}
function productHasModel(p,model){return p.fitment?.includes(model)||(p.fitmentRules||[]).some(r=>r.models?.includes(model));}
function wheelFitmentMatches(p,v){
  if(p.category!=="WH"||!p.wheelFitment||!v)return true;
  const group=catalogMeta?.wheelGroups?.[p.wheelFitment.fitmentGroup];
  return !!group?.models?.includes(v.model);
}
function productMatches(p,{category=activeCategoryFilter,model=activeModelFilter,vehicle=activeVehicle}={}){
  if(activeProductFilter!=="all")return false;
  if(category!=="all"&&p.category!==category)return false;
  if(model!=="all"&&!productHasModel(p,model))return false;
  if(!vehicle)return true;
  if(!wheelFitmentMatches(p,vehicle))return false;
  if((p.fitmentRules||[]).some(r=>ruleMatches(r,vehicle)))return true;
  if(p.fitmentRules?.length)return false;
  if(!productHasModel(p,vehicle.model))return false;
  if(!valueMatches(p.fuel,vehicle.fuel))return false;
  if(p.engines?.length&&!p.engines.includes("All")&&!p.engines.includes(vehicle.engineId)&&!p.engines.includes(vehicle.engine))return false;
  if(p.variants?.length&&!p.variants.includes("All")&&!p.variants.includes(vehicle.variant))return false;
  if(!valueMatches(p.drivetrains,vehicle.drivetrain))return false;
  if(!valueMatches(p.transmissions,vehicle.transmission))return false;
  return true;
}
function ruleSummary(r){
  const modelsText=(r.models||[]).join(" / ");
  const years=r.yearFrom||r.yearTo?(r.yearFrom||"start")+"–"+(r.yearTo||"slutt"):"alle år";
  const fuel=fuelListLabel(r.fuel)||"alle drivstoff";
  const variant=(r.variants?.length&&!(r.variants.length===1&&r.variants[0]==="All"))?` · ${r.variants.join(" / ")}`:"";
  const engine=(r.engines?.length&&!(r.engines.length===1&&r.engines[0]==="All"))?` · ${r.engines.join(" / ")}`:"";
  const drivetrain=(r.drivetrains?.length&&!(r.drivetrains.length===1&&r.drivetrains[0]==="All"))?` · ${r.drivetrains.map(drivetrainLabel).join(" / ")}`:"";
  const transmission=(r.transmissions?.length&&!(r.transmissions.length===1&&r.transmissions[0]==="All"))?` · ${r.transmissions.map(transmissionLabel).join(" / ")}`:"";
  return `${modelsText} · ${years} · ${fuel}${variant}${engine}${drivetrain}${transmission}`;
}
function ruleCardSummary(r){
  const modelsText=(r.models||[]).join(" / ");
  const years=r.yearFrom||r.yearTo?(r.yearFrom||"start")+"–"+(r.yearTo||"slutt"):"alle år";
  const pieces=[`${modelsText} · ${years}`];
  const fuels=(r.fuel||[]).filter(v=>v&&v!=="All");
  if(fuels.length) pieces.push(fuels.map(fuelLabel).join(" / "));
  const variants=(r.variants||[]).filter(v=>v&&v!=="All");
  if(variants.length) pieces.push(variants.join(" / "));
  const transmissions=(r.transmissions||[]).filter(v=>v&&v!=="All");
  if(transmissions.length) pieces.push(transmissions.map(transmissionLabel).join(" / "));
  const drivetrains=(r.drivetrains||[]).filter(v=>v&&v!=="All");
  if(drivetrains.length) pieces.push(drivetrains.map(drivetrainLabel).join(" / "));
  return pieces.join(" · ");
}
function productCompatibility(p){
  const rules=p.fitmentRules||[];
  if(activeVehicle){
    const matched=rules.find(r=>ruleMatches(r,activeVehicle));
    if(matched)return `<span class="compatibilityOk">✓ Passer din MINI</span><small>${esc(ruleCardSummary(matched))}</small>`;
  }
  const summary=rules.length?rules.map(ruleCardSummary).join(" · "):(p.fitment||[]).join(" / ")||"Ikke definert";
  return `<span>${esc(summary)}</span>`;
}
function productStatusBadge(p){
  if(p?.status==='verified')return '<span class="csVerifiedBadge" title="Cooper Supply Verified">CS VERIFIED</span>';
  if(p?.status==='active')return '<span class="productActiveBadge">AKTIV</span>';
  return '';
}
function csVerifiedBadge(p){return p?.status==='verified'?'<span class="csVerifiedBadge" title="Cooper Supply Verified">CS VERIFIED</span>':'';}
function productCard(p){
  const statusBadge=productStatusBadge(p);
  const productHref=`/products/${encodeURIComponent(p.slug||p.id)}`;
  const unavailable=p?.stockStatus==='out_of_stock';
  return `<div class="product"><a class="productLink productCardLink" href="${productHref}"><div class="productImg">${p.images?.[0]?`<img src="${esc(p.images[0])}" alt="${esc(p.name)}" loading="lazy">`:`<span>${esc((p.fitment||[]).join(" / "))}</span>`}</div><div class="productInfo"><h3>${esc(p.name)}</h3>${statusBadge}<div class="fitmentText">${productCompatibility(p)}</div><div class="price">${displayPrice(p)}</div>${stockStatusBadge(p)}</div></a><div class="productCardActions"><a class="buy productDetailsBtn" href="${productHref}">SE DETALJER</a><button class="buy productAddBtn${unavailable?' disabled':''}" type="button" data-add-cart="${p.id}" ${unavailable?'disabled':''}>${unavailable?'IKKE PÅ LAGER':'LEGG I HANDLEKURV'}</button></div></div>`;
}
function renderShopVehicleProfile(){
  const bar=document.getElementById("shopVehicleProfile");
  if(!bar)return;
  const selection=document.getElementById("fitmentSelection");
  const action=document.getElementById("shopVehicleAction");
  const reset=document.getElementById("shopVehicleReset");
  if(activeVehicle){
    if(selection)selection.textContent=vehicleSummary(activeVehicle);
    bar.classList.add("hasVehicle");
    if(action){action.textContent="ENDRE MODELL →";action.type="button";}
    reset?.classList.remove("hidden");
  }else{
    if(selection)selection.textContent="Ingen MINI valgt";
    bar.classList.remove("hasVehicle");
    if(action){action.textContent="VELG DIN MINI →";action.type="button";}
    reset?.classList.add("hidden");
  }
}
function renderProducts(){
  renderShopVehicleProfile();
  const list=products.filter(productMatches);
  const shown=list.slice(0,visibleProductLimit);
  document.getElementById("productGrid").innerHTML=shown.map(productCard).join("")||'<div class="emptyState">Ingen katalogprodukter matcher valgt bil og filtre.</div>';
  const count=document.getElementById("productCount");
  if(count)count.textContent=`${list.length} ${list.length===1?"produkt":"produkter"}`;
  const more=document.getElementById("loadMoreProducts");
  if(more){
    more.classList.toggle("hidden",shown.length>=list.length);
    more.textContent=`Vis flere (${Math.min(48,list.length-shown.length)})`;
  }
}
function setModelFilter(model){
  activeModelFilter=model;activeVehicle=null;activeCategoryFilter="all";visibleProductLimit=48;
  document.getElementById("fitmentSelection").textContent=model==="all"?"Ingen MINI valgt":`${model} chassis valgt`;
  document.getElementById("fitmentStatus").textContent="";
  renderCategories();
  renderProducts();
}
function setCategoryFilter(category){
  activeCategoryFilter=category;visibleProductLimit=48;
  document.querySelectorAll(".categoryFilter").forEach(x=>x.classList.toggle("active",x.dataset.categoryFilter===category));
  renderCategories();
  if(category!=="all")document.getElementById("products").scrollIntoView({behavior:"smooth"});
  renderProducts();
}
function normalizedCartProduct(p,qty){return {...p,price:p.price==null?null:Number(p.price),salePrice:p.salePrice==null?null:Number(p.salePrice),images:Array.isArray(p.images)?[...p.images]:[],qty:Math.max(1,Number(qty??p.qty??1))};}
function cartUnitPrice(p){const regular=p.price==null?null:Number(p.price);const sale=p.salePrice==null?null:Number(p.salePrice);return sale!=null&&regular!=null&&sale>0&&sale<regular?sale:regular;}
function updateCart(){
  const count=cart.reduce((sum,p)=>sum+(Number(p.qty)||1),0);
  document.getElementById("cartCount").textContent=count;
  document.getElementById("cartItems").innerHTML=cart.length?cart.map(p=>`<div class="cartRow"><span>${esc(p.name)}<br><small>${esc(p.sku)}</small></span><span class="cartRowRight"><b>${displayPrice(p)}</b><span class="cartQty"><label class="cartQtyLabel">Antall <input class="cartQtyInput" type="number" min="1" step="1" inputmode="numeric" value="${Math.max(1,Number(p.qty)||1)}" data-cart-qty="${p.id}" aria-label="Antall av ${esc(p.name)}"></label><button type="button" class="cartRemove" data-cart-remove="${p.id}" aria-label="Fjern ${esc(p.name)}" title="Fjern produkt">🗑️</button></span></span></div>`).join(""):"<p style='color:#9ca8a2'>Ingen bekreftede produkter er lagt i handlekurven.</p>";
  const priced=cart.flatMap(p=>Array(Number(p.qty)||1).fill(cartUnitPrice(p)));
  document.getElementById("cartTotal").textContent=priced.length?(priced.every(v=>Number.isFinite(v))?money(priced.reduce((a,b)=>a+b,0)):"Pris kommer"):"0,-";
}
let cartToastTimer=null;
function showCartToast(product){
  const toast=document.getElementById("cartToast");
  if(!toast)return;
  const cartItem=cart.find(x=>x.id===product?.id);
  const qty=Math.max(1,Number(cartItem?.qty)||1);
  const price=displayPrice(product||{});
  toast.querySelector("[data-toast-name]").textContent=product?.name||"Produkt";
  const meta=toast.querySelector("[data-toast-meta]");
  if(meta)meta.textContent=`${price} · ${qty} ${qty===1?"stk.":"stk."}`;
  toast.classList.remove("hidden");
  clearTimeout(cartToastTimer);
  cartToastTimer=setTimeout(()=>toast.classList.add("hidden"),2000);
}
function hideCartToast(){clearTimeout(cartToastTimer);document.getElementById("cartToast")?.classList.add("hidden");}

let storefrontCatalogHydrated=false;
async function hydrateStorefrontCatalog(){
  const previousProducts=products;
  try{
    const response=await fetch('/api/storefront/catalog',{headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error(`Catalog API ${response.status}`);
    const data=await response.json();
    if(Array.isArray(data.models)&&data.models.length)models=data.models;
    if(Array.isArray(data.categories)&&data.categories.length)categories=data.categories;
    if(Array.isArray(data.engines)&&data.engines.length)engines=data.engines;
    if(Array.isArray(data.products))products=data.products;
    if(data.catalogMeta)catalogMeta=data.catalogMeta;
    if(Number.isFinite(Number(data.shippingCents)))window.COOPER_SHIPPING_DISPLAY_CENTS=Number(data.shippingCents);
  }catch(err){
    // Keep the bundled static catalog as a safe fallback when the backend is unavailable.
    console.warn('Storefront catalog API unavailable; using bundled fallback catalog.',err);
  }
  if(cart.length){ cart=cart.map(item=>{const fresh=products.find(x=>x.id===item.id); return fresh?normalizedCartProduct(fresh,item.qty):null;}).filter(Boolean); }
  renderCategories();
  // Populate the selector only on the initial catalog load. Rebuilding it during
  // the 2-second live refresh resets an in-progress customer selection.
  if(!storefrontCatalogHydrated){
    populateFitmentModel();
    restoreVehicleSelection();
  }
  renderProducts();
  updateCart();
  if(!storefrontCatalogHydrated){storefrontCatalogHydrated=true;renderRoute();}
  else refreshCurrentProductRoute(previousProducts);
}
function currentProductPageId(){const el=document.querySelector("[data-product-page-id]");return el?Number(el.dataset.productPageId):null;}
function productLiveSignature(p){return p?JSON.stringify({id:p.id,name:p.name,status:p.status,price:p.price,salePrice:p.salePrice,fitment:p.fitment,fitmentRules:p.fitmentRules,images:p.images,brand:p.brand,category:p.category,subcategory:p.subcategory,material:p.material,finish:p.finish}):"";}
function refreshCurrentProductRoute(previousProducts){
  const id=currentProductPageId();
  if(!id||document.querySelector(".expiredProduct"))return;
  const oldProduct=previousProducts?.find(p=>p.id===id);
  const live=products.find(p=>p.id===id);
  if(!live||productLiveSignature(oldProduct)===productLiveSignature(live))return;
  const y=window.scrollY;
  const rv=document.getElementById("routeView");
  if(rv){rv.innerHTML=productPageMarkup(live);requestAnimationFrame(()=>window.scrollTo({top:y,behavior:"instant"}));}
}
hydrateStorefrontCatalog();
let catalogRefreshTimer=setInterval(()=>{if(!document.hidden)hydrateStorefrontCatalog();},2000);

function restoreVehicleSelection(){
  try{
    const saved=JSON.parse(localStorage.getItem(vehicleStorageKey)||"null");
    if(!saved)return;
    const model=modelMap[saved.model];
    const engine=engines.find(e=>e.id===saved.engineId);
    if(!model||!engine)return;
    document.getElementById("fitModel").value=saved.model;
    updateFitmentFields();
    document.getElementById("fitYear").value=String(saved.year);
    updateEngineFields();
    document.getElementById("fitEngine").value=saved.engineId;
    updateConditionalVehicleOptions();
    if(saved.drivetrain&&document.getElementById("fitDrivetrain"))document.getElementById("fitDrivetrain").value=saved.drivetrain;
    if(saved.transmission&&document.getElementById("fitTransmission"))document.getElementById("fitTransmission").value=saved.transmission;
    const v=buildVehicle();
    if(v){activeVehicle=v;activeModelFilter=v.model;document.getElementById("manualFitment")?.classList.remove("hidden");document.getElementById("manualFitmentToggle")?.setAttribute("aria-expanded","true");renderVehicleData(v);document.getElementById("resetFitment")?.classList.remove("hidden");document.getElementById("fitmentSelection").textContent=vehicleSummary(v);renderCategories();renderProducts();}
  }catch(e){localStorage.removeItem(vehicleStorageKey);}
}

const manualToggle=document.getElementById("manualFitmentToggle");
manualToggle?.addEventListener("click",()=>{
  const panel=document.getElementById("manualFitment");
  if(!panel)return;
  const open=panel.classList.toggle("hidden")===false;
  manualToggle.setAttribute("aria-expanded",String(open));
});
document.getElementById("regLookupBtn")?.addEventListener("click",()=>{
  const value=document.getElementById("regNumber")?.value;
  const vehicle=applyRegistrationVehicle(value,"fitmentStatus");
  if(!vehicle)return;
  renderVehicleData(vehicle);
  document.getElementById("manualFitment")?.classList.add("hidden");
  document.getElementById("manualFitmentToggle")?.setAttribute("aria-expanded","false");
  document.getElementById("resetFitment")?.classList.remove("hidden");
  document.getElementById("fitmentSelection").textContent=vehicleSummary(vehicle);
  renderCategories();
  renderProducts();
  navigate("/shop");
});

document.getElementById("fitModel").addEventListener("change",updateFitmentFields);
document.getElementById("fitYear").addEventListener("change",updateEngineFields);
document.getElementById("fitEngine").addEventListener("change",()=>{updateConditionalVehicleOptions();const v=buildVehicle();if(v)renderVehicleData(v);else document.getElementById("fitVehicleData").innerHTML="";});
document.getElementById("fitDrivetrain").addEventListener("change",()=>{const v=buildVehicle();if(v)renderVehicleData(v);});
document.getElementById("fitTransmission").addEventListener("change",()=>{const v=buildVehicle();if(v)renderVehicleData(v);});
restoreVehicleSelection();

function catalogVehicleSelection(){
  const model=models.find(x=>x.code===document.getElementById("catalogFitModel")?.value);
  const engine=engines.find(x=>x.id===document.getElementById("catalogFitEngine")?.value);
  const year=Number(document.getElementById("catalogFitYear")?.value);
  if(!model||!engine||!year)return null;
  const ds=drivetrainOptions(engine,year),ts=transmissionOptions(engine,year);
  const drivetrain=ds.length===1?ds[0]:document.getElementById("catalogFitDrivetrain")?.value||null;
  const transmission=ts.length===1?ts[0]:document.getElementById("catalogFitTransmission")?.value||null;
  if(ds.length>1&&!drivetrain)return null;
  if(ts.length>1&&!transmission)return null;
  return {model:model.code,year,body:model.bodyStyle,engineId:engine.id,variant:engine.variant,fuel:engine.fuel,engine:engine.engine,power:powerForYear(engine,year),drivetrain:drivetrain||"FWD",transmission:transmission||null,lci:resolveLci(model.code,{year})};
}
function renderCatalogVehicleData(){
  const el=document.getElementById("catalogVehicleData");
  if(!el)return;
  const v=catalogVehicleSelection();
  el.innerHTML=v?`<div class="vehicleResult catalogVehicleResult"><div><b>${esc(v.model)} · ${v.year}</b><span>${esc(v.body)}</span></div><div><b>${esc(v.variant)}</b><span>${esc(fuelLabel(v.fuel))} · ${esc(v.engine)}</span></div><div><b>${v.power} HK</b><span>${v.drivetrain?esc(drivetrainLabel(v.drivetrain)):""}${v.transmission?` · ${esc(transmissionLabel(v.transmission))}`:""}</span></div></div>`:"";
}
function setCatalogConditionalField(fieldId, optionsId, values, placeholder, {show=false}={}){
  const field=document.getElementById(fieldId);
  const select=document.getElementById(optionsId);
  if(!field||!select)return;
  const shouldShow=show&&values.length>1;
  field.classList.toggle("hidden",!shouldShow);
  fillOptions(optionsId,placeholder,values,!shouldShow);
  if(shouldShow)select.disabled=false;
}

// Registration lookup is shared by the homepage finder and the catalogue finder.
// The test mapping is intentionally local until the Vegvesen integration is connected.
const registrationTestVehicles={
  "DK60771":{model:"R53",year:2004,engineId:"R53-S-16-163",drivetrain:"FWD",transmission:"Manual"}
};
function normalizeRegistration(value){return String(value||"").replace(/\s+/g,"").toUpperCase();}
function vehicleFromRegistration(value){
  const data=registrationTestVehicles[normalizeRegistration(value)];
  if(!data)return null;
  const model=models.find(x=>x.code===data.model);
  const engine=engines.find(x=>x.id===data.engineId);
  if(!model||!engine)return null;
  return {model:model.code,year:data.year,body:model.bodyStyle,engineId:engine.id,variant:engine.variant,fuel:engine.fuel,engine:engine.engine,power:powerForYear(engine,data.year),drivetrain:data.drivetrain||"FWD",transmission:data.transmission||null,lci:resolveLci(model.code,{year:data.year})};
}
function applyRegistrationVehicle(value,statusElementId){
  const input=normalizeRegistration(value);
  if(!input){
    const status=document.getElementById(statusElementId);
    if(status)status.textContent="Skriv inn registreringsnummer først.";
    return null;
  }
  const vehicle=vehicleFromRegistration(input);
  const status=document.getElementById(statusElementId);
  if(!vehicle){
    if(status)status.textContent="Registreringsnummeret ble ikke funnet.";
    return null;
  }
  activeVehicle=vehicle;
  activeModelFilter=vehicle.model;
  activeCategoryFilter="all";
  localStorage.setItem(vehicleStorageKey,JSON.stringify(vehicle));
  if(status)status.textContent="";
  return vehicle;
}

function setCatalogRegistrationMode(enabled){
  const reg=document.getElementById("catalogRegSection");
  const toggle=document.getElementById("catalogRegToggle");
  const regInput=document.getElementById("catalogRegNumber");
  if(!reg||!toggle)return;
  reg.classList.toggle("hidden",!enabled);
  toggle.classList.toggle("hidden",enabled);
  toggle.setAttribute("aria-expanded",String(enabled));
  if(enabled)setTimeout(()=>regInput?.focus(),20);
}
function openCatalogSelector(){
  const panel=document.getElementById("catalogSelectorPanel");
  if(!panel)return;
  const m=document.getElementById("catalogFitModel");
  const y=document.getElementById("catalogFitYear");
  const e=document.getElementById("catalogFitEngine");
  const d=document.getElementById("catalogFitDrivetrain");
  const t=document.getElementById("catalogFitTransmission");
  setCatalogRegistrationMode(false);
  document.getElementById("catalogSelectorStatus").textContent="";
  fillOptions("catalogFitModel","Velg modell",models.map(x=>({value:x.code,label:`${x.code} — ${x.name}`})));
  fillOptions("catalogFitYear","Velg år",[],true);
  fillOptions("catalogFitEngine","Velg motor / variant",[],true);
  setCatalogConditionalField("catalogFitDrivetrainField","catalogFitDrivetrain",[],"Velg drivlinje");
  setCatalogConditionalField("catalogFitTransmissionField","catalogFitTransmission",[],"Velg girkasse");
  if(activeVehicle){
    m.value=activeVehicle.model;
    const model=models.find(x=>x.code===activeVehicle.model);
    if(model){fillOptions("catalogFitYear","Velg år",availableYears(model));y.value=String(activeVehicle.year);}
    const avEng=availableEngines(model,String(activeVehicle.year));fillOptions("catalogFitEngine","Velg motor / variant",avEng);e.value=activeVehicle.engineId;
    // Match the homepage selector's initial state: conditional choices are not
    // exposed until the customer interacts with the engine/variant selection.
    const eng=engines.find(x=>x.id===activeVehicle.engineId);
    if(eng){
      const ds=drivetrainOptions(eng,Number(activeVehicle.year)),ts=transmissionOptions(eng,Number(activeVehicle.year));
      fillOptions("catalogFitDrivetrain","Velg drivlinje",ds.map(v=>({value:v,label:drivetrainLabel(v)})),true);
      fillOptions("catalogFitTransmission","Velg girkasse",ts.map(v=>({value:v,label:transmissionLabel(v)})),true);
      if(activeVehicle.drivetrain&&d)d.value=activeVehicle.drivetrain;
      if(activeVehicle.transmission&&t)t.value=activeVehicle.transmission;
    }
  }
  renderCatalogVehicleData();
  panel.classList.remove("hidden");
  setTimeout(()=>m?.focus(),20);
}
function closeCatalogSelector(){setCatalogRegistrationMode(false);document.getElementById("catalogSelectorPanel")?.classList.add("hidden");}
function updateCatalogFitment(){
  const m=models.find(x=>x.code===document.getElementById("catalogFitModel")?.value);
  fillOptions("catalogFitYear","Velg år",m?availableYears(m):[],!m);
  fillOptions("catalogFitEngine","Velg motor / variant",[],true);
  setCatalogConditionalField("catalogFitDrivetrainField","catalogFitDrivetrain",[],'Velg drivlinje');
  setCatalogConditionalField("catalogFitTransmissionField","catalogFitTransmission",[],'Velg girkasse');
  renderCatalogVehicleData();
}
function updateCatalogEngine(){
  const model=models.find(x=>x.code===document.getElementById("catalogFitModel")?.value);
  const year=document.getElementById("catalogFitYear")?.value;
  fillOptions("catalogFitEngine","Velg motor / variant",availableEngines(model,year),!model||!year);
  setCatalogConditionalField("catalogFitDrivetrainField","catalogFitDrivetrain",[],'Velg drivlinje');
  setCatalogConditionalField("catalogFitTransmissionField","catalogFitTransmission",[],'Velg girkasse');
  renderCatalogVehicleData();
}
function updateCatalogConditions(){
  const eng=engines.find(x=>x.id===document.getElementById("catalogFitEngine")?.value);
  const year=Number(document.getElementById("catalogFitYear")?.value);
  const ds=eng&&year?drivetrainOptions(eng,year):[],ts=eng&&year?transmissionOptions(eng,year):[];
  setCatalogConditionalField("catalogFitDrivetrainField","catalogFitDrivetrain",ds.map(v=>({value:v,label:drivetrainLabel(v)})),'Velg drivlinje',{show:true});
  setCatalogConditionalField("catalogFitTransmissionField","catalogFitTransmission",ts.map(v=>({value:v,label:transmissionLabel(v)})),'Velg girkasse',{show:true});
  renderCatalogVehicleData();
}
document.getElementById("shopVehicleAction")?.addEventListener("click",e=>{e.preventDefault();openCatalogSelector();});
document.getElementById("shopVehicleReset")?.addEventListener("click",()=>clearVehicleSelection({scrollToTop:false}));
document.getElementById("catalogFitModel")?.addEventListener("change",updateCatalogFitment);
document.getElementById("catalogFitYear")?.addEventListener("change",updateCatalogEngine);
document.getElementById("catalogFitEngine")?.addEventListener("change",updateCatalogConditions);
document.getElementById("catalogFitDrivetrain")?.addEventListener("change",renderCatalogVehicleData);
document.getElementById("catalogFitTransmission")?.addEventListener("change",renderCatalogVehicleData);
document.getElementById("catalogSelectorClose")?.addEventListener("click",closeCatalogSelector);
document.getElementById("catalogRegToggle")?.addEventListener("click",()=>setCatalogRegistrationMode(true));
document.getElementById("catalogFitmentForm")?.addEventListener("submit",e=>{
  e.preventDefault();
  if(!document.getElementById("catalogRegSection")?.classList.contains("hidden")){
    const value=document.getElementById("catalogRegNumber")?.value;
    const vehicle=applyRegistrationVehicle(value,"catalogSelectorStatus");
    if(!vehicle)return;
    document.getElementById("fitmentSelection").textContent=vehicleSummary(vehicle);
    document.getElementById("resetFitment")?.classList.remove("hidden");
    renderCategories();
    renderProducts();
    closeCatalogSelector();
    return;
  }
  if(!document.getElementById("catalogManualSection")?.classList.contains("hidden")){
    const selected=catalogVehicleSelection();
    if(!selected){
      const model=document.getElementById("catalogFitModel")?.value,year=document.getElementById("catalogFitYear")?.value,engine=document.getElementById("catalogFitEngine")?.value;
      document.getElementById("catalogSelectorStatus").textContent=!model||!year||!engine?"Velg modell, år og motor / variant først.":"Velg de gjenværende kjøretøyvalgene.";
      return;
    }
    activeVehicle=selected;
    activeModelFilter=activeVehicle.model;activeCategoryFilter="all";
    localStorage.setItem(vehicleStorageKey,JSON.stringify(activeVehicle));
    document.getElementById("fitmentSelection").textContent=vehicleSummary(activeVehicle);document.getElementById("resetFitment")?.classList.remove("hidden");renderCategories();renderProducts();
    document.getElementById("catalogSelectorStatus").textContent="";closeCatalogSelector();
  }
});

document.addEventListener("click",e=>{
  const routeLink=e.target.closest('a[href^="#/"],a[href^="/"]');
  if(routeLink){
    const href=routeLink.getAttribute('href')||'/';
    if(href.startsWith('/admin'))return;
    if(href==='#' || href.startsWith('/#')){if(routeLink.id==='shopVehicleAction'){e.preventDefault();openCatalogSelector();}return;}
    e.preventDefault();
    const target=href.startsWith('#/')?href:href;
    if(target==='/checkout')document.getElementById('cartPanel')?.classList.add('hidden');
    if(target==='/'||target==='#/'||target==='#/home')clearVehicleSelection();
    navigate(target);
    return;
  }
  const infoLink=e.target.closest("[data-info]");
  if(infoLink){e.preventDefault();openInfoPage(infoLink.dataset.info);return;}
  const filter=e.target.closest("[data-filter]");if(filter){document.querySelectorAll(".filter:not(.categoryFilter)").forEach(x=>x.classList.remove("active"));filter.classList.add("active");activeProductFilter=filter.dataset.filter;renderProducts();return;}
  const categoryFilter=e.target.closest("[data-category-filter]");if(categoryFilter){setCategoryFilter(categoryFilter.dataset.categoryFilter);return;}
  const modelCategoryFilter=e.target.closest("[data-model-category-filter]");if(modelCategoryFilter){setModelFilter(modelCategoryFilter.dataset.modelCategoryFilter);return;}
  const category=e.target.closest("[data-category]");if(category){setCategoryFilter(category.dataset.category);return;}
  const routeCategory=e.target.closest("[data-route-category]");if(routeCategory){navigate(`/shop/${routeCategory.dataset.routeModel}/${routeCategory.dataset.routeCategory}`);return;}
  if(e.target.classList.contains("overlay")){e.target.classList.add("hidden");return;}
  const addCart=e.target.closest("[data-add-cart]");if(addCart){const p=products.find(x=>x.id===Number(addCart.dataset.addCart));if(p&&p.stockStatus!=='out_of_stock'){const existing=cart.find(x=>x.id===p.id);if(existing)existing.qty=(Number(existing.qty)||1)+1;else cart.push(normalizedCartProduct(p,1));updateCart();showCartToast(p);}return;}
  const removeCart=e.target.closest("[data-cart-remove]");if(removeCart){cart=cart.filter(x=>x.id!==Number(removeCart.dataset.cartRemove));updateCart();if(!cart.length&&location.pathname==="/checkout")navigate("/");return;}
  const clearCart=e.target.closest("[data-cart-clear]");if(clearCart){cart=[];updateCart();if(location.pathname==="/checkout")navigate("/");return;}
  const toastCart=e.target.closest("[data-toast-cart]");if(toastCart){hideCartToast();document.getElementById('cartPanel')?.classList.remove('hidden');return;}
  const close=e.target.closest("[data-close]");if(close)document.getElementById(close.dataset.close).classList.add("hidden");
});
document.addEventListener("change",e=>{
  const qtyInput=e.target.closest("[data-cart-qty]");
  if(!qtyInput)return;
  const item=cart.find(x=>x.id===Number(qtyInput.dataset.cartQty));
  if(!item)return;
  const parsed=Math.floor(Number(qtyInput.value));
  item.qty=Number.isFinite(parsed)&&parsed>=1?parsed:1;
  updateCart();
});

document.addEventListener("keydown",e=>{
  if(e.key==="Enter" && e.target.closest("[data-cart-qty]")){
    e.preventDefault();
    e.target.blur();
    return;
  }
  if(e.key!=="Escape")return;
  document.querySelectorAll(".overlay:not(.hidden)").forEach(el=>el.classList.add("hidden"));
});
document.getElementById("loadMoreProducts")?.addEventListener("click",()=>{visibleProductLimit+=48;renderProducts();});

document.getElementById("fitmentForm").addEventListener("submit",e=>{
  e.preventDefault();
  const v=buildVehicle();
  if(!v){document.getElementById("fitmentStatus").textContent="Velg alle nødvendige valg for bilen din først.";return;}
  activeVehicle=v;activeModelFilter=v.model;activeCategoryFilter="all";
  document.getElementById("manualFitment")?.classList.remove("hidden");
  document.getElementById("manualFitmentToggle")?.setAttribute("aria-expanded","true");
  localStorage.setItem(vehicleStorageKey,JSON.stringify(v));
  document.getElementById("fitmentSelection").textContent=vehicleSummary(v);
  document.getElementById("fitmentStatus").textContent="";
  document.getElementById("resetFitment")?.classList.remove("hidden");
  renderVehicleData(v);renderCategories();renderProducts();navigate("/shop");
});

document.getElementById("resetFitment")?.addEventListener("click",()=>clearVehicleSelection({scrollToTop:false}));

document.getElementById("searchBtn").onclick=()=>{document.getElementById("searchPanel").classList.remove("hidden");document.getElementById("searchInput").focus();};
document.getElementById("cartBtn").onclick=()=>document.getElementById("cartPanel").classList.remove("hidden");

function checkoutItemsPayload(){return cart.map(p=>({id:Number(p.id),qty:Math.max(1,Math.floor(Number(p.qty)||1))}));}
function checkoutTotal(){return cart.reduce((sum,p)=>{const unit=cartUnitPrice(p);return sum+(Number.isFinite(unit)?unit*(Number(p.qty)||1):0)},0);}
function checkoutCustomerText(value){
  if(!value)return value;
  const text=String(value);
  const translations={
    "Not a real product. Created only to test shared fitment across chassis.":"Ikke et ekte produkt. Kun opprettet for å teste felles kompatibilitet på tvers av chassis.",
    "Not a real product. Created only to stress-test catalogue filtering.":"Ikke et ekte produkt. Kun opprettet for å stressteste filtreringen i katalogen.",
    "Not a real product. Created only to stress-test catalog filtering.":"Ikke et ekte produkt. Kun opprettet for å stressteste filtreringen i katalogen.",
    "Synthetic demo product for Cooper Supply testing.":"Syntetisk demo-produkt for testing av Cooper Supply."
  };
  return translations[text]||text;
}
function checkoutProductDetails(p){
  const rules=p.fitmentRules||[];
  const detailFields=[['SKU',p.sku],['Produktstatus',p.status==='verified'?'Verifisert':'Aktiv'],['Lagerstatus',stockStatusLabel(p.stockStatus)],['Merke',p.brand],['Kategori',categoryMap[p.category]||p.category],['Underkategori',p.subcategory],['Materiale',p.material],['Finish / farge',p.finish],['Hva følger med',p.includedItems||p.included],['Montering',p.installation],['Garanti',p.warranty],['Produsentens delenummer',p.manufacturerPartNumber]];
  const details=detailFields.filter(([,v])=>v).map(([k,v])=>`<div><small>${esc(k)}</small><strong>${esc(v)}</strong></div>`).join("");
  const fitment=rules.length?`<div class="checkoutFitment"><small>KOMPATIBILITET</small>${rules.map(r=>`<span>${esc(ruleSummary(r))}</span>`).join("")}</div>`:`<div class="checkoutFitment"><small>KOMPATIBILITET</small><span>Kompatibilitet ikke definert.</span></div>`;
  const description=p.description?`<p class="checkoutProductDescription">${esc(checkoutCustomerText(p.description))}</p>`:"";
  return `<div class="checkoutProductCard"><div class="checkoutProductHead">${p.images?.[0]?`<img src="${esc(p.images[0])}" alt="${esc(p.name)}">`:""}<div><b>${esc(p.name)} ${csVerifiedBadge(p)}</b><div class="checkoutProductPrice">${Number.isFinite(cartUnitPrice(p))?money(cartUnitPrice(p)*(Number(p.qty)||1)):'Pris kommer'}</div><small>${Number(p.qty)||1} stk.</small></div></div>${description}${fitment}<div class="checkoutDetailGrid">${details}</div></div>`;
}
function checkoutMarkup(message=''){
  const total=checkoutTotal();
  const shippingKnown=Number.isFinite(window.COOPER_SHIPPING_DISPLAY_CENTS)&&window.COOPER_SHIPPING_DISPLAY_CENTS>0;
  const SHIPPING_DISPLAY_CENTS=Number(window.COOPER_SHIPPING_DISPLAY_CENTS||0);
  const shippingLine=shippingKnown?money(SHIPPING_DISPLAY_CENTS/100):'Beregnes i neste steg';
  const grandTotal=shippingKnown?money(total+SHIPPING_DISPLAY_CENTS/100):money(total);
  return `<section class="checkoutPage"><div class="checkoutTop"><a class="backLink" href="/shop">← Til nettbutikken</a><span class="eyebrow">SIKKER BETALING</span><h1>BESTILLING</h1><p>Fyll inn leveringsinformasjon og kontroller hele bestillingen før du går videre til betaling.</p></div>${message?`<div class="checkoutMessage">${esc(message)}</div>`:''}<div class="checkoutGrid"><form id="checkoutForm" class="checkoutForm"><h2>Leveringsinformasjon</h2><div class="checkoutFields"><label>Fornavn<input name="firstName" autocomplete="given-name" required></label><label>Etternavn<input name="lastName" autocomplete="family-name" required></label><label>E-post<input name="email" type="email" autocomplete="email" required></label><label>Telefon<input name="phone" autocomplete="tel" required></label><label class="wide">Adresse<input name="address" autocomplete="street-address" required></label><label class="wide">Adresselinje 2 <span>(valgfritt)</span><input name="address2" autocomplete="address-line2"></label><label>Postnummer<input name="postalCode" inputmode="numeric" autocomplete="postal-code" required></label><label>Poststed<input name="city" autocomplete="address-level2" required></label></div><div class="paymentMethods"><h2>Betalingsmåte</h2><label class="paymentOption"><input type="radio" name="paymentMethod" value="klarna" checked><span><b>Klarna</b><small>Klarna Playground · testbetaling</small></span></label><label class="paymentOption"><input type="radio" name="paymentMethod" value="stripe"><span><b>Kort</b><small>Visa / Mastercard · Stripe testmodus</small></span></label></div><div id="checkoutError" class="checkoutError hidden"></div><button class="btn primary checkoutPay" type="submit">FORTSETT TIL KLARNA →</button><p id="checkoutFine" class="checkoutFine">Fraktberegning er klargjort som egen del av checkout og kan kobles til faktisk fraktoppsett før lansering.</p></form><aside class="checkoutSummary"><h2>Din ordre</h2>${cart.map(p=>checkoutProductDetails(p)).join("")}<div class="checkoutSum"><span>Varer</span><strong>${money(total)}</strong></div><div class="checkoutSum"><span>Frakt</span><strong>${shippingLine}</strong></div><div class="checkoutGrand"><span>${shippingKnown?'Totalt':'Totalt før frakt'}</span><strong>${grandTotal}</strong></div></aside></div></section>`;
}
async function submitCheckout(form){
  const error=document.getElementById('checkoutError'),button=form.querySelector('button[type="submit"]');
  const method=form.querySelector('input[name="paymentMethod"]:checked')?.value||'klarna';
  error.classList.add('hidden');button.disabled=true;button.textContent=method==='stripe'?'STARTER KORTBETALING …':'STARTER KLARNA …';
  try{
    const fields=Object.fromEntries(new FormData(form).entries());
    const customer={firstName:fields.firstName,lastName:fields.lastName,email:fields.email,phone:fields.phone,address:fields.address,address2:fields.address2,postalCode:fields.postalCode,city:fields.city};
    const endpoint=method==='stripe'?'/api/checkout/stripe/session':'/api/checkout/klarna/session';
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({customer,items:checkoutItemsPayload()})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.redirectUrl)throw new Error(data.error||'Kunne ikke starte betalingen.');
    location.href=data.redirectUrl;
  }catch(err){
    error.textContent=err.message;error.classList.remove('hidden');button.disabled=false;button.textContent=method==='stripe'?'FORTSETT TIL KORTBETALING →':'FORTSETT TIL KLARNA →';
  }
}
async function renderCheckoutResult(){
  const params=new URLSearchParams(location.search),order=params.get('order')||'',orderId=params.get('order_id')||'',sessionId=params.get('session_id')||'',provider=params.get('provider')||'klarna';
  const providerName=provider==='stripe'?'Stripe':'Klarna';
  let html;if(location.pathname==='/checkout/success')html=`<section class="checkoutResult"><span class="eyebrow">BETALING BEKREFTES</span><h1>VENT LITT …</h1><p>Vi bekrefter betalingen med ${providerName} før bestillingen markeres som gjennomført.</p></section>`;else if(location.pathname==='/checkout/cancel')html=`<section class="checkoutResult"><span class="eyebrow">BETALING AVBRUTT</span><h1>BETALINGEN BLE AVBRUTT</h1><p>Ingen ny betaling er fullført. Du kan gå tilbake til bestillingen og prøve igjen.</p><a class="btn primary" href="/checkout">TILBAKE TIL BESTILLING →</a></section>`;else html=`<section class="checkoutResult"><span class="eyebrow">BETALING</span><h1>NOE GIKK GALT</h1><p>${providerName} kunne ikke fullføre betalingen. Du kan prøve igjen.</p><a class="btn primary" href="/checkout">PRØV IGJEN →</a></section>`;
  showRouteView(html);
  if(location.pathname==='/checkout/success'&&order){
    try{
      const query=provider==='stripe'?`session_id=${encodeURIComponent(sessionId)}`:`order_id=${encodeURIComponent(orderId)}`;
      const response=await fetch(`/api/checkout/order/${encodeURIComponent(order)}?${query}`);
      const data=await response.json().catch(()=>({}));
      if(!response.ok||data.status!=='authorized')throw new Error(data.error||'Betalingen kunne ikke bekreftes.');
      showRouteView(`<section class="checkoutResult"><span class="eyebrow">BESTILLING MOTTATT</span><h1>TAKK FOR BESTILLINGEN</h1><p>Betalingen er bekreftet hos ${providerName}. Ordren din er ${esc(order)}.</p><a class="btn primary" href="/shop">FORTSETT Å HANDLE →</a></section>`);
      cart=[];updateCart();
    }catch(err){showRouteView(`<section class="checkoutResult"><span class="eyebrow">BETALING</span><h1>BETALINGEN MÅ BEKREFTES</h1><p>${esc(err.message||'Vi klarte ikke å bekrefte betalingen akkurat nå. Ikke legg inn en ny ordre før statusen er avklart.')}</p><a class="btn primary" href="/shop">TIL NETTBUTIKKEN →</a></section>`);}
  }
}
const infoPages={
  shipping:{eyebrow:"KUNDESERVICE",title:"FRAKT OG LEVERING",html:`
    <p class="legalLead">Vi viser tilgjengelige leveringsalternativer, fraktkostnad og forventet leveringstid før bestillingen gjennomføres. Endelige fraktbetingelser fylles inn når transportør og fraktoppsett er valgt.</p>
    <div class="legalCards">
      <div><b>Levering</b><span>Ordrebekreftelsen skal angi hvilke varer som er bestilt og relevant leveringsinformasjon.</span></div>
      <div><b>Fraktkostnad</b><span>Fraktkostnaden skal være kjent for kunden før bestillingen sendes inn.</span></div>
      <div><b>Forsendelse</b><span>Når sendingen kan spores, får kunden sporingsinformasjon via oppgitt kontaktkanal.</span></div>
      <div><b>Transportskade</b><span>Ta kontakt med Cooper Supply så snart som mulig og oppgi ordrenummer. Bilder og annen dokumentasjon kan være nyttig for saken.</span></div>
    </div>
    <div class="legalDraft">FØR LANSERING: Fyll inn faktisk transportør, leveringsområder, fraktpriser, forventede leveringstider og rutine for transportskade.</div>`},
  returns:{eyebrow:"KUNDESERVICE",title:"RETUR OG BYTTE",html:`
    <p class="legalLead">Retur av en vare fordi kunden har ombestemt seg, reklamasjon på en mangelfull vare og eventuelle frivillige bytter er tre forskjellige prosesser. Vi holder disse adskilt.</p>
    <div class="legalCards">
      <div><b>Angrerett</b><span>Forbrukere som handler på nett har normalt 14 dagers angrerett. Se siden «Angrerett» for prosessen.</span></div>
      <div><b>Reklamasjon</b><span>Ved feil eller mangel skal saken sendes til «Reklamasjon». Dette er ikke det samme som en vanlig retur.</span></div>
      <div><b>Bytte</b><span>Bytte er en frivillig ordning dersom Cooper Supply tilbyr dette for den aktuelle varen. Eventuelle vilkår oppgis før kjøp.</span></div>
      <div><b>Tilbakebetaling</b><span>Ved bruk av angreretten håndteres tilbakebetaling etter angrerettlovens regler. Status på returen dokumenteres i kundeservice-saken.</span></div>
    </div>
    <div class="legalDraft">FØR LANSERING: Bestem returadresse, returmetode, hvem som betaler returfrakt ved angrerett, eventuell bytteordning og hvilke produktgrupper som eventuelt har lovlige unntak.</div>`},
  withdrawal:{eyebrow:"KUNDEINFORMASJON",title:"ANGRERETT",html:`
    <p class="legalLead">Ved fjernsalg til forbrukere gjelder normalt 14 dagers angrerett. Fristen løper fra den dagen forbrukeren får varen i fysisk besittelse. Forbrukeren kan melde fra om bruk av angreretten ved et standardisert angreskjema eller ved en annen tydelig erklæring.</p>
    <div class="legalCards">
      <div><b>14 dager</b><span>Angrefristen er normalt 14 dager fra varen er kommet i fysisk besittelse. Ved manglende informasjon om angreretten kan fristen bli utvidet etter loven.</span></div>
      <div><b>Melding</b><span>Du kan melde angrerett skriftlig. Dersom Cooper Supply tilbyr elektronisk melding, skal mottak bekreftes på et varig medium.</span></div>
      <div><b>Retur</b><span>Varen skal normalt sendes tilbake uten unødig opphold og senest 14 dager etter at angreretten er meldt.</span></div>
      <div><b>Returkostnad</b><span>Ved angrerett bæres de direkte returkostnadene normalt av forbrukeren når dette er opplyst før kjøpet.</span></div>
      <div><b>Tilbakebetaling</b><span>Cooper Supply skal normalt tilbakebetale mottatte betalinger uten unødig opphold og senest 14 dager etter at meldingen om angrerett er mottatt. Tilbakebetaling kan holdes tilbake til varen er mottatt eller dokumentasjon på retur er fremlagt.</span></div>
      <div><b>Verdireduksjon</b><span>Unødvendig håndtering kan gi ansvar for verdireduksjon når vilkårene i angrerettloven er oppfylt.</span></div>
    </div>
    <h4>Standardisert angreskjema</h4>
    <p>Ved lansering skal standardisert angreskjema være tilgjengelig for kjøp som omfattes av angrerett, og kunden skal få nødvendige opplysninger om angreretten før kjøpet.</p>
    <form id="withdrawalForm" class="claimForm" onsubmit="event.preventDefault();document.getElementById('withdrawalStatus').textContent='Meldingen er registrert lokalt i demoen. I produksjon skal meldingen sendes til Cooper Supply og bekreftes på varig medium.'">
      <div class="claimGrid">
        <label>ORDRENUMMER<input name="order" placeholder="CS-ORD-0001" required></label>
        <label>E-POST<input type="email" name="email" placeholder="deg@epost.no" required></label>
        <label class="fullField">MELDING<textarea name="message" rows="4" placeholder="Jeg ønsker å benytte angreretten for følgende kjøp..."></textarea></label>
      </div>
      <button class="btn primary full" type="submit">MELD ANGRERETT</button>
      <div id="withdrawalStatus" class="formStatus"></div>
    </form>
    <div class="legalDraft">FØR LANSERING: Koble skjemaet til ordresystem/e-post, legg inn faktisk returadresse og publiser korrekt standardisert angreskjema sammen med ordrebekreftelsen.</div>`},
  complaints:{eyebrow:"KUNDESERVICE",title:"REKLAMASJON",html:`
    <p class="legalLead">Hvis en vare har en mangel som ikke skyldes kunden eller forhold på kundens side, kan kunden ha krav på blant annet retting, omlevering, prisavslag, heving eller erstatning etter forbrukerkjøpsloven.</p>
    <div class="legalCards">
      <div><b>Reklamasjonsfrist</b><span>Forbrukeren må reklamere innen rimelig tid etter at mangelen ble oppdaget. Fristen kan aldri være kortere enn to måneder fra oppdagelsen. Den ytre fristen er normalt to år, eller fem år når varen eller deler av den er ment å vare vesentlig lenger.</span></div>
      <div><b>Dokumentasjon</b><span>Oppgi ordrenummer, produkt/SKU og beskriv feilen. Bilder, video, feilkoder eller annen relevant dokumentasjon kan gjøre behandlingen enklere.</span></div>
      <div><b>Kompatibilitet</b><span>Ved saker om kompatibilitet sammenholder Cooper Supply produktets verifiserte passform med bilen som ble valgt ved kjøpet.</span></div>
      <div><b>Avhjelp</b><span>Ved en berettiget mangel skjer retting eller omlevering etter lovens regler. Ved slike saker skal kunden normalt ikke bære kostnadene ved lovpålagt avhjelp.</span></div>
    </div>
    <form id="claimForm" class="claimForm" onsubmit="event.preventDefault();document.getElementById('claimStatus').textContent='Reklamasjonen er registrert lokalt i demoen. Produksjonsversjonen kobles til kundeservice/ordresystem.'">
      <div class="claimGrid">
        <label>ORDRENUMMER<input name="order" placeholder="CS-ORD-0001" required></label>
        <label>E-POST<input type="email" name="email" placeholder="deg@epost.no" required></label>
        <label>PRODUKT / SKU<input name="product" placeholder="Produktnavn eller SKU"></label>
        <label>TYPE SAK<select name="issue"><option>Feil / mangel</option><option>Passform / kompatibilitet</option><option>Transportskade</option><option>Mangler i pakken</option><option>Annet</option></select></label>
        <label class="fullField">BIL VED KJØP<input name="vehicle" placeholder="R56 · 2011 · Cooper SD · N47 · 143 HK"></label>
        <label class="fullField">BESKRIVELSE<textarea name="description" rows="5" placeholder="Beskriv feilen og når den ble oppdaget."></textarea></label>
      </div>
      <button class="btn primary full" type="submit">SEND REKLAMASJON</button>
      <div id="claimStatus" class="formStatus"></div>
    </form>
    <div class="legalDraft">FØR LANSERING: Koble skjemaet til faktisk kundeservicekanal og fastsett intern behandlingstid, returprosedyre og dokumentasjonsrutiner. Innholdet skal aldri redusere kundens lovpålagte rettigheter.</div>`},
  warranty:{eyebrow:"KUNDEINFORMASJON",title:"GARANTI",html:`
    <p class="legalLead">En garanti er en frivillig forpliktelse som kommer i tillegg til forbrukerens lovbestemte rettigheter. Eventuell garanti vil alltid oppgis konkret for hvert produkt.</p>
    <div class="legalCards">
      <div><b>Produktspesifikk garanti</b><span>Produktet skal oppgi hvem som stiller garantien, garantiperioden og hvilke vilkår som gjelder.</span></div>
      <div><b>Ikke i stedet for reklamasjon</b><span>En garanti erstatter ikke reklamasjonsretten etter forbrukerkjøpsloven.</span></div>
      <div><b>Montering og bruk</b><span>Eventuelle spesifikke vilkår for montering, bruk eller service må fremgå tydelig og være saklig begrunnet.</span></div>
      <div><b>Garanti eller reklamasjon</b><span>Kundeservice klassifiserer saken etter om den behandles som frivillig garanti eller som en lovbestemt reklamasjon.</span></div>
    </div>
    <div class="legalDraft">FØR LANSERING: Legg inn kun garantivilkår som er dokumentert av produsent eller som Cooper Supply selv faktisk tilbyr.</div>`},
  compatibility:{eyebrow:"PASSFORM",title:"KOMPATIBILITET",html:`
    <p class="legalLead">Cooper Supply bruker eksplisitte kompatibilitetsregler for chassis, årsmodell, drivstoff, motor og variant. Et produkt skal ikke markedsføres som kompatibelt bare fordi det står «MINI R-Series» eller «Cooper S».</p>
    <div class="legalCards">
      <div><b>Chassis</b><span>Produktet må ha uttrykkelig dokumentert chassis-kompatibilitet før det publiseres som kompatibelt.</span></div>
      <div><b>Bensin / diesel</b><span>Motor- og drivverkdeler filtreres etter drivstofftype. Bensindeler skal ikke automatisk vises for dieselbiler, og omvendt.</span></div>
      <div><b>Motor og variant</b><span>Der produktet krever det, kan kompatibilitet snevres inn til bestemt motor, variant eller årsintervall.</span></div>
      <div><b>Kundens valgte bil</b><span>Produksjonsversjonen skal knytte valgt MINI og den matchende kompatibilitetsregel til ordren.</span></div>
    </div>
    <p>Dette gjør det mulig å skille mellom en del som passer selve chassiset og en del som krever bestemt motor/drivverk.</p>
    <div class="legalDraft">Kompatibilitetsinformasjon er en del av produktinformasjonen. Den skal være kontrollert mot produsent-/leverandørdokumentasjon eller intern verifikasjon før produktet publiseres som bekreftet kompatibelt.</div>`},
  terms:{eyebrow:"KUNDEINFORMASJON",title:"SALGSBETINGELSER",html:`
    <p class="legalLead">Disse salgsbetingelsene skal brukes ved Cooper Supply sitt salg av varer til forbrukere i Norge. Lovpålagte forbrukerrettigheter gjelder uavhengig av formuleringene i vilkårene.</p>
    <div class="legalCards">
      <div><b>1. Selger</b><span><strong>[FORETAKSNAVN]</strong><br>Org.nr.: [ORG.NR.]<br>Adresse: [ADRESSE]<br>E-post: [E-POST]<br>Telefon: [TELEFON]</span></div>
      <div><b>2. Avtalen</b><span>Avtalen består av opplysningene i bestillingen, disse salgsbetingelsene og eventuelle særskilt avtalte vilkår. Ufravikelig forbrukerlovgivning går foran vilkårene.</span></div>
      <div><b>3. Priser og betaling</b><span>Pris, eventuelle avgifter og leveringskostnader skal fremgå tydelig før bestilling. Tilgjengelige betalingsmetoder og eventuelle betalingsvilkår vises i kassen.</span></div>
      <div><b>4. Bestilling</b><span>Bestillingsløsningen skal tydelig vise at kunden pådrar seg en betalingsforpliktelse ved å sende bestillingen. Kunden skal kunne lese og aktivt akseptere salgsbetingelsene.</span></div>
      <div><b>5. Levering</b><span>Leveringsmåte, pris og forventet leveringstid skal fremgå av bestillingsløsningen. Regler om forsinkelse og manglende levering følger forbrukerkjøpsloven.</span></div>
      <div><b>6. Angrerett</b><span>Forbrukere har normalt 14 dagers angrerett ved nettkjøp av varer. Se siden «Angrerett» for detaljert informasjon.</span></div>
      <div><b>7. Mangel og reklamasjon</b><span>Forbrukeren kan ha krav på retting, omlevering, prisavslag, heving og erstatning når vilkårene i forbrukerkjøpsloven er oppfylt.</span></div>
      <div><b>8. Garanti</b><span>Eventuell garanti er frivillig og kommer i tillegg til lovbestemte rettigheter. Garantivilkår oppgis per produkt.</span></div>
      <div><b>9. Personvern</b><span>Personopplysninger behandles i samsvar med gjeldende personvernregler. Se personvernerklæringen.</span></div>
      <div><b>10. Klager og tvister</b><span>Ta først kontakt med Cooper Supply slik at saken kan forsøkes løst. Eventuelle utenrettslige klageordninger oppgis dersom virksomheten er tilknyttet en slik ordning.</span></div>
    </div>
    <div class="legalDraft">FØR LANSERING: Erstatt plassholderne med faktiske firmaopplysninger og tilpass levering, betaling, returadresse og eventuelle klageordninger til det faktiske oppsettet.</div>`},
  cookies:{eyebrow:"KUNDEINFORMASJON",title:"INFORMASJONSKAPSLER",html:`
    <p class="legalLead">Cooper Supply skal bare bruke informasjonskapsler og lignende sporingsteknologier på den måten regelverket tillater. Nødvendig teknisk lagring og valgfrie formål skal holdes adskilt.</p>
    <div class="legalCards">
      <div><b>Nødvendige</b><span>Teknologi som er strengt nødvendig for å levere en tjeneste kunden uttrykkelig ber om, kan være unntatt fra samtykkekravet.</span></div>
      <div><b>Analyse</b><span>Valgfrie analyseverktøy skal ikke aktiveres før gyldig samtykke er gitt dersom teknologien omfattes av samtykkekravet.</span></div>
      <div><b>Markedsføring</b><span>Markedsførings- og sporingsverktøy må beskrives tydelig og krever samtykke når de omfattes av reglene.</span></div>
      <div><b>Valg og tilbaketrekking</b><span>Det skal være like lett å avslå som å godta valgfrie formål, og samtykke skal være mulig å trekke tilbake på en enkel måte.</span></div>
    </div>
    <div class="legalDraft">FØR LANSERING: Kartlegg faktisk cookie-/sporingsoppsett. Ikke legg inn leverandørnavn eller formål som ikke faktisk brukes på nettsiden.</div>`},
  privacy:{eyebrow:"KUNDEINFORMASJON",title:"PERSONVERN",html:`
    <p class="legalLead">Cooper Supply skal informere tydelig om hvilke personopplysninger som behandles, hvorfor de behandles, hvor lenge de lagres, hvem de deles med og hvilke rettigheter den registrerte har.</p>
    <div class="legalCards">
      <div><b>Ordre og kundeservice</b><span>Navn, kontaktopplysninger, leveringsinformasjon og ordredata kan behandles for å inngå og oppfylle kjøpsavtalen og håndtere kundeservice.</span></div>
      <div><b>Bil og fitment</b><span>Opplysninger om MINI, årsmodell, motor og variant kan knyttes til ordre eller support når dette er nødvendig for kompatibilitet og kundeservice.</span></div>
      <div><b>Betaling og levering</b><span>Betalings- og fraktleverandører kan motta opplysninger som er nødvendige for å gjennomføre betaling og levering.</span></div>
      <div><b>Informasjon og rettigheter</b><span>Personvernerklæringen skal forklare behandlingsgrunnlag, lagring, mottakere, overføring utenfor EØS der relevant og hvordan den registrerte kan bruke sine rettigheter.</span></div>
    </div>
    <p>Aktuelle rettigheter kan blant annet omfatte innsyn, retting, sletting, begrensning av behandling, protest og dataportabilitet når vilkårene er oppfylt. Du kan også klage til Datatilsynet.</p>
    <div class="legalDraft">FØR LANSERING: Fyll inn faktisk behandlingsansvarlig, kontaktopplysninger, systemleverandører, lagringstider, behandlingsgrunnlag og reell cookie-/analysebruk. Innholdet skal speile det Cooper Supply faktisk gjør.</div>`}
};

function openInfoPage(key){
  const page=infoPages[key];
  if(!page)return;
  document.getElementById("infoPanelBody").innerHTML=`<span class="eyebrow">${esc(page.eyebrow)}</span><h3>${esc(page.title)}</h3>${page.html}`;
  document.getElementById("infoPanel").classList.remove("hidden");
}



/* V21 page architecture -------------------------------------------------- */
function pageSections(){return [
  document.querySelector(".hero"),document.querySelector(".trust"),
  document.getElementById("categories"),
  document.getElementById("products"),document.getElementById("showcase"),document.querySelector(".about"),
  document.querySelector(".newsletter")
].filter(Boolean);}
function setPageSectionVisibility(visibleIds=[]){
  const set=new Set(visibleIds.filter(Boolean));
  pageSections().forEach(el=>{
    const visible=set.has(el);
    el.classList.toggle("routeHidden",!visible);
    el.hidden=!visible;
    if(visible) el.style.removeProperty("display");
    else el.style.display="none";
  });
}
function showOnly(ids=[]){
  setPageSectionVisibility(ids);
  const rv=document.getElementById("routeView");
  if(rv){rv.classList.add("hidden");rv.hidden=true;rv.style.display="none";}
  window.scrollTo({top:0,behavior:"instant"});
}
function showRouteView(html,extraSections=[]){
  setPageSectionVisibility(extraSections.map(id=>document.getElementById(id)));
  const rv=document.getElementById("routeView");
  rv.innerHTML=html;
  rv.classList.remove("hidden");
  rv.hidden=false;
  rv.style.display="block";
  window.scrollTo({top:0,behavior:"instant"});
}
function navigate(hash){
  const target=String(hash||'#/');
  const path=target.startsWith('#/')?target.slice(1):target;
  if(location.pathname===path && !location.hash){renderRoute();return;}
  history.pushState({path},'',path);
  renderRoute();
}
function productPageMarkup(p){
  const rules=p.fitmentRules||[];
  const fields=[['SKU',p.sku],['Merke',p.brand],['Kategori',categoryMap[p.category]||p.category],['Underkategori',p.subcategory],['Produktstatus',p.status==='verified'?'Verifisert':'Aktiv'],['Lagerstatus',stockStatusLabel(p.stockStatus)],['Generasjon',p.generation],['Modell',p.model],['Årsmodell',p.yearRange],['Karosseritype',p.bodyType],['Drivstoff',fuelListLabel(p.fuel)],['Motor / variant',p.engineVariant],['Venstre / høyre / begge',p.side],['Drivlinje',(p.drivtrains||[]).map(drivetrainLabel).join(" / ")],['Girkasse',(p.transmissions||[]).map(transmissionLabel).join(" / ")],['Spesifikasjoner',p.specifications],['Materiale',p.material],['Farge / finish',p.finish],['Dette følger med',p.includedItems||p.included],['Montering',p.installation],['Garanti',p.warranty],['Godkjenning / homologering',p.certification],['Leverandør',p.supplier],['Produsentens delenummer',p.manufacturerPartNumber],['Frakt',p.shipping]];
  if(p.wheelFitment){
    fields.push(['Boltsirkel',p.wheelFitment.boltPattern],['Navdiameter',p.wheelFitment.hubBore+' mm'],['Felgdiameter',p.wheelFitment.wheelDiameter+'"'],['Felgbredde',p.wheelFitment.width+'J'],['ET',p.wheelFitment.offset+' mm'],['Bremseklaring',p.wheelFitment.brakeClearance]);
  }
  if(p.brakeFitment){
    fields.push(['Bremseaksel',p.brakeFitment.axle],['Bremsetype',p.brakeFitment.brakeSystem],['Skivediameter',p.brakeFitment.rotorDiameter],['Kaliper',p.brakeFitment.caliperType],['Minste felgdiameter',p.brakeFitment.minimumWheelDiameter],['Klaringsklasse',p.brakeFitment.clearanceClass]);
  }
  const defined=fields.filter(([,v])=>v);
  const fitmentHtml=rules.length?`<section class="detailFit publicFitment"><b>KOMPATIBILITET</b>${rules.map(r=>`<span>${esc(ruleSummary(r))}</span>`).join("")}</section>`:'<section class="detailFit publicFitment"><b>KOMPATIBILITET</b><span>Kompatibilitet er ikke definert ennå.</span></section>';
  const statusBadge=csVerifiedBadge(p); const imageHtml=(p.images||[]).length?`<div class="routeProductImages">${p.images.map(src=>`<img src="${esc(src)}" alt="${esc(p.name)}">`).join('')}</div>`:'';
  const detailCells=defined.map(([k,v])=>`<div><small>${esc(k)}</small><p>${esc(v)}</p></div>`).join("");
  const purchaseUnavailable=p?.stockStatus==='out_of_stock';
  const purchaseCell=`<div class="detailPurchaseCell"><small>KJØP</small><div class="detailPurchasePrice">${displayPrice(p)}</div><button class="productBuyBtn${purchaseUnavailable?' disabled':''}" type="button" data-add-cart="${p.id}" ${purchaseUnavailable?'disabled':''}>${purchaseUnavailable?'IKKE PÅ LAGER':'LEGG I HANDLEKURV'}</button></div>`;
  return `<section class="routeProduct" data-product-page-id="${p.id}"><div class="routeProductTop"><a class="backLink" href="/shop">← Til nettbutikken</a><span class="eyebrow">${esc(categoryMap[p.category]||p.category)}</span><h1>${esc(p.name)} ${statusBadge}</h1></div><div class="routeProductBody">${imageHtml}${fitmentHtml}<div class="detailGrid">${detailCells}${purchaseCell}</div><p class="detailNote">Kompatibilitet vises ut fra produktets dokumenterte kompatibilitetsregler.</p></div></section>`;
}
function expiredProductMarkup(){return `<section class="routeProduct expiredProduct"><div class="routeProductTop"><a class="backLink" href="/shop">← Til nettbutikken</a><span class="eyebrow">PRODUKT IKKE TILGJENGELIG</span><h1>UTGÅTT</h1><p class="expiredLead">Dette produktet er ikke lenger tilgjengelig i Cooper Supply.</p></div><div class="routeProductBody"><a class="btn primary" href="/shop">TILBAKE TIL NETTBUTIKKEN →</a></div></section>`;}
let statusPollTimer=null;
function stopProductStatusPoll(){if(statusPollTimer){clearInterval(statusPollTimer);statusPollTimer=null;}}
function startProductStatusPoll(id){stopProductStatusPoll();statusPollTimer=setInterval(async()=>{try{const r=await fetch(`/api/storefront/products/${id}/status`,{cache:'no-store'});if(r.status===410||r.status===404){if(!document.querySelector('.expiredProduct'))showRouteView(expiredProductMarkup());return;}if(r.ok){const d=await r.json();if(d.status==='verified'||d.status==='active'){const live=products.find(x=>x.id===id);if(live&&document.querySelector('.expiredProduct'))showRouteView(productPageMarkup(live));return;}if(!document.querySelector('.expiredProduct'))showRouteView(expiredProductMarkup());}}catch(e){}},2000);}
function openProductBySlugFromPath(){const match=location.pathname.match(/^\/products\/([^/]+)\/?$/i);if(!match)return false;const slug=decodeURIComponent(match[1]);const p=products.find(x=>x.slug===slug);if(!p){navigate('/shop');return true;}navigate(`/product/${p.id}`);return true;}
function renderRoute(){
  stopProductStatusPoll();
  const directProduct=location.pathname.match(/^\/products\/([^/]+)\/?$/i);
  if(directProduct){ const slug=decodeURIComponent(directProduct[1]); const direct=products.find(x=>x.slug===slug); if(!direct){fetch(`/api/storefront/products/slug/${encodeURIComponent(slug)}/status`,{cache:'no-store'}).then(r=>{if(r.status===410||r.status===404){showRouteView(expiredProductMarkup());return;}return r.json().then(d=>{const live=products.find(x=>x.id===d.id);if(live){showRouteView(productPageMarkup(live));startProductStatusPoll(live.id);}else{showRouteView(expiredProductMarkup());}})}).catch(()=>showRouteView(expiredProductMarkup()));return;} showRouteView(productPageMarkup(direct));startProductStatusPoll(direct.id);return; }
  const raw=location.hash ? location.hash.replace(/^#\/?/,"") : location.pathname.replace(/^\/+|\/+$/g,"");
  const parts=raw.split("/").filter(Boolean);
  const route=parts[0]||"home";
  if(route==="home"){showOnly([document.querySelector(".hero"),document.querySelector(".trust"),document.getElementById("showcase"),document.querySelector(".about"),document.querySelector(".newsletter")].filter(Boolean));return;}
  if(route==="models"){navigate("/shop");return;}
  if(route==="shop"){
    const routeModel=parts[1] ? modelMap[parts[1].toUpperCase()] : null;
    const routeCategory=parts[2] && categories.some(c=>c[0]===parts[2].toUpperCase()) ? parts[2].toUpperCase() : "all";
    const keepVehicle=!!activeVehicle && (!routeModel || routeModel.code===activeVehicle.model);
    if(routeModel && !keepVehicle) activeVehicle=null;
    activeModelFilter=routeModel?routeModel.code:(keepVehicle?activeVehicle.model:"all");
    activeCategoryFilter=routeCategory;
    renderCategoryFilters();renderProducts();
    showOnly([document.querySelector(".shopIntro"),document.getElementById("products")]);
    return;
  }
  if(route==="product"){
    const p=products.find(x=>x.id===Number(parts[1]));
    if(!p){navigate("/shop");return;}
    showRouteView(productPageMarkup(p));startProductStatusPoll(p.id);return;
  }
  if(route==="checkout"){
    if(["success","cancel","failure"].includes(parts[1]||'')){renderCheckoutResult();return;}
    if(!cart.length){showRouteView(`<section class="checkoutResult"><span class="eyebrow">HANDLEKURV</span><h1>HANDLEKURVEN ER TOM</h1><p>Legg til et produkt før du går videre til betaling.</p><a class="btn primary" href="/shop">TIL NETTBUTIKKEN →</a></section>`);return;}
    showRouteView(checkoutMarkup(new URLSearchParams(location.search).get('payment')==='back'?'Betalingen ble avbrutt. Du kan prøve igjen.':''));
    const checkoutForm=document.getElementById('checkoutForm');
    checkoutForm?.addEventListener('submit',e=>{e.preventDefault();submitCheckout(e.currentTarget)});
    checkoutForm?.querySelectorAll('input[name="paymentMethod"]').forEach(input=>input.addEventListener('change',()=>{
      const method=input.value,button=checkoutForm.querySelector('.checkoutPay'),fine=document.getElementById('checkoutFine');
      if(input.checked&&method==='stripe'){button.textContent='FORTSETT TIL KORTBETALING →';fine.textContent='Du sendes videre til Stripe sin sikre betalingsside. Testbetaling bruker Stripe testmodus.';}
      if(input.checked&&method==='klarna'){button.textContent='FORTSETT TIL KLARNA →';fine.textContent='Du sendes videre til Klarnas sikre betalingsside. Testbetaling bruker Klarna Playground.';}
    }));
    return;
  }
  if(route==="showcase"){
    showRouteView(`<section class="showcasePage"><div class="showcasePageVisual"><img src="/assets/showcase/r53-showcase.jpg" alt="Cooper Supply 2002 MINI Cooper S R53 showcasebil"></div><div class="showcasePageCopy"><a class="backLink" href="/">← Til forsiden</a><span class="eyebrow">THE COOPER SUPPLY R53</span><h1><span>BYGGET FOR Å</span><span>TESTE DELENE.</span></h1><p>Dette er vår 2002 MINI Cooper S R53 — bilen vi bruker som showcase og testplattform for Cooper Supply.</p><div class="showcasePageFacts"><div><small>MODELL</small><strong>R53</strong></div><div><small>ÅR</small><strong>2002</strong></div><div><small>ROLLE</small><strong>SHOWCASE / TESTBIL</strong></div></div><a class="btn primary" href="/shop">SE DELER →</a></div></section>`);return;
  }
  if(route==="about"){
    showRouteView(`<section class="routeCopy"><span class="eyebrow">OM COOPER SUPPLY</span><h1>R-SERIEN SPESIALIST.</h1><p>Cooper Supply er en norsk spesialbutikk for ettermarkedsdeler til MINI R-serien. Vi bygger butikken rundt nyttige produkter, tydelig fitment-informasjon og en katalog som kan vokse fra innkjøpte produkter til egne Cooper Supply-produkter.</p><p>MINI-modellnavn brukes kun beskrivende for kompatibilitet. Cooper Supply er vårt eget merkenavn.</p></section>`);return;
  }
  if(route==="contact"){
    showRouteView(`<section class="routeCopy"><span class="eyebrow">KONTAKT</span><h1>TA KONTAKT.</h1><p>Cooper Supply er under oppbygging. Kontaktinformasjon og kundeservicekanaler fylles inn før lansering.</p><div class="legalDraft">FØR LANSERING: Legg inn faktisk e-postadresse, telefon, åpningstider og foretaksinformasjon.</div></section>`);return;
  }
  navigate("/");
}
window.addEventListener("hashchange",renderRoute);window.addEventListener("popstate",renderRoute);
document.getElementById("searchInput").addEventListener("input",e=>{
  visibleProductLimit=48;
  const q=e.target.value.toLowerCase().trim();
  const matches=!q?[]:products.filter(p=>productMatches(p)&&`${p.name} ${p.sku} ${p.fitment?.join(" ")} ${categoryMap[p.category]} ${(p.fuel||[]).join(" ")} ${(p.variants||[]).join(" ")} ${(p.engineVariant||"")} ${(p.drivetrains||[]).join(" ")} ${(p.transmissions||[]).join(" ")} ${(p.fitmentRules||[]).map(ruleSummary).join(" ")}`.toLowerCase().includes(q));
  document.getElementById("searchResults").innerHTML=matches.map(p=>`<div class="result"><b>${esc(p.name)}</b><br><small>${esc(p.sku)} · ${esc(categoryMap[p.category])} · Passform: ${esc((p.fitment||[]).join(" / "))}</small><a class="buy" href="/products/${encodeURIComponent(p.slug||p.id)}">SE PRODUKT</a></div>`).join("")||(q?'<p style="color:#9ca8a2">Ingen definerte katalogprodukter funnet.</p>':'');
});

renderRoute();


// ZV7.2.1 — single responsive navigation for desktop and mobile.
(()=>{const toggle=document.getElementById("mobileNavToggle"),nav=document.getElementById("mainNav");if(!toggle||!nav)return;const close=()=>{nav.classList.remove("mobileNavOpen");toggle.setAttribute("aria-expanded","false");toggle.setAttribute("aria-label","Åpne meny")};toggle.addEventListener("click",()=>{const open=nav.classList.toggle("mobileNavOpen");toggle.setAttribute("aria-expanded",String(open));toggle.setAttribute("aria-label",open?"Lukk meny":"Åpne meny")});nav.addEventListener("click",e=>{if(e.target.closest("a"))close()});window.addEventListener("resize",()=>{if(window.innerWidth>700)close()})})();
