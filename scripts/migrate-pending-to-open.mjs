// One-time migration: rewrite correctionRequests.status "Pending" -> "Open".
// Run: node scripts/migrate-pending-to-open.mjs
// Uses the firebase CLI's stored OAuth token (read+write via Firestore REST API).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT = "atd-time-tracking";
const cfgPath = join(homedir(), ".config", "configstore", "firebase-tools.json");
const tokens = JSON.parse(readFileSync(cfgPath, "utf8")).tokens;
if (!tokens || !tokens.refresh_token) { console.error("No firebase CLI refresh token found."); process.exit(1); }

async function getAccessToken() {
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) return tokens.access_token;
  const body = new URLSearchParams({ grant_type:"refresh_token", refresh_token:tokens.refresh_token, client_id:tokens.client_id, client_secret:tokens.client_secret });
  const r = await fetch("https://oauth2.googleapis.com/token", { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body });
  if (!r.ok) throw new Error("refresh failed "+r.status+" "+await r.text());
  return (await r.json()).access_token;
}

function unwrap(v){ if(!v) return undefined; if(v.nullValue!==undefined) return null; if(v.booleanValue!==undefined) return v.booleanValue; if(v.integerValue!==undefined) return Number(v.integerValue); if(v.doubleValue!==undefined) return v.doubleValue; if(v.stringValue!==undefined) return v.stringValue; if(v.timestampValue!==undefined) return v.timestampValue; if(v.arrayValue&&v.arrayValue.values) return v.arrayValue.values.map(unwrap); if(v.mapValue&&v.mapValue.fields){const o={};for(const[k,x]of Object.entries(v.mapValue.fields))o[k]=unwrap(x);return o;} return v; }

const token = await getAccessToken();

// Query all correctionRequests with status == "Pending".
const qUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`;
const qBody = { structuredQuery:{ from:[{collectionId:"correctionRequests"}], where:{fieldFilter:{field:{fieldPath:"status"},op:"EQUAL",value:{stringValue:"Pending"}}} } };
const qr = await fetch(qUrl, { method:"POST", headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"}, body:JSON.stringify(qBody) });
if (!qr.ok) { console.error("Query failed", qr.status, await qr.text()); process.exit(1); }
const qj = await qr.json();
const pendingDocs = qj.filter(item => item.document).map(item => ({ name: item.document.name, id: item.document.name.split("/").pop(), data: item.document.fields }));

console.log(`Found ${pendingDocs.length} correctionRequests with status "Pending".`);

if (pendingDocs.length === 0) {
  console.log("Nothing to migrate. Exiting.");
  process.exit(0);
}

let migrated = 0;
let failed = 0;
for (const doc of pendingDocs) {
  // PATCH the status field via Firestore REST commit (write).
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:commit`;
  const commitBody = {
    writes: [{
      update: { name: doc.name, fields: { ...doc.data, status: { stringValue: "Open" } } },
      currentDocument: { exists: true },
    }],
  };
  const cr = await fetch(commitUrl, { method:"POST", headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"}, body:JSON.stringify(commitBody) });
  if (cr.ok) {
    migrated++;
    console.log(`  Migrated ${doc.id} -> Open`);
  } else {
    failed++;
    console.error(`  FAILED ${doc.id}: ${cr.status} ${await cr.text()}`);
  }
}

console.log(`\nMigration complete: ${migrated} migrated, ${failed} failed, ${pendingDocs.length} total.`);
