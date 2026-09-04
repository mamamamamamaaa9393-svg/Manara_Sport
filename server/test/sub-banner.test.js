global.window = {};
const fs = require("fs");
const code = fs.readFileSync("roster/js/sub-banner.js", "utf8");
eval(code);
const SubBanner = global.window.SubBanner;

function makeEl() { return { innerHTML: "", style: {}, _display: function(){return this.style.display;} }; }
function run(label, st) {
  const el = makeEl();
  SubBanner.render(el, st);
  const shown = el.style.display !== "none" && el.innerHTML.length > 0;
  const hasSubscribe = /اشترك الآن|subscribe/i.test(el.innerHTML);
  console.log(label + " => display:" + (el.style.display||"(unset)") + " subscribeCTA:" + hasSubscribe + " | " + (el.innerHTML.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,60)));
  return { shown, hasSubscribe };
}

// 1) Paid + trial still in future (the reported bug): status active, trial present
run("ACTIVE+futureTrial", { status:"active", price:299, currency:"ج.م", trial:{ started:true, end:new Date(Date.now()+6*864e5).toISOString(), daysLeft:6, expired:false }, subscription:{ periodEnd:new Date(Date.now()+30*864e5).toISOString() } });

// 2) Paid via pending review during trial (status trialing but pendingTransaction set)
run("TRIALING+pendingTx", { status:"trialing", price:299, currency:"ج.م", trial:{ started:true, end:new Date(Date.now()+6*864e5).toISOString(), daysLeft:6, expired:false }, pendingTransaction:{ id:"tx_1" } });

// 3) status pending (awaiting_review)
run("PENDING", { status:"pending", price:299, currency:"ج.م", pendingTransaction:{ id:"tx_2" } });

// 4) Genuine trialing, no payment
const r4 = run("TRIALING-noPay", { status:"trialing", price:299, currency:"ج.م", trial:{ started:true, end:new Date(Date.now()+6*864e5).toISOString(), daysLeft:6, expired:false } });

// 5) Expired
const r5 = run("EXPIRED", { status:"expired", price:299, currency:"ج.م" });

// 6) Past due
run("PAST_DUE", { status:"past_due", price:299, currency:"ج.م" });

// 7) cancel_at_period_end
run("CANCEL", { status:"cancel_at_period_end", price:299, currency:"ج.م", subscription:{ periodEnd:new Date(Date.now()+10*864e5).toISOString() } });

console.log("\nASSERTIONS:");
console.log("ACTIVE shows NO subscribe CTA:", run("x",{status:"active",trial:{end:new Date(Date.now()+6*864e5).toISOString(),expired:false},subscription:{periodEnd:new Date(Date.now()+30*864e5).toISOString()}}).hasSubscribe === false);
console.log("TRIALING+pendingTx shows NO subscribe CTA:", run("x",{status:"trialing",trial:{end:new Date(Date.now()+6*864e5).toISOString(),expired:false},pendingTransaction:{id:"t"}}).hasSubscribe === false);
console.log("Genuine trialing SHOWS subscribe CTA:", r4.hasSubscribe === true);
console.log("Expired SHOWS subscribe CTA:", r5.hasSubscribe === true);

