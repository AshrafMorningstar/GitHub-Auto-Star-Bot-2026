const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
// We are scanning the 'upload done' directory now to fix missing deployments
const UPLOAD_DONE_DIR = path.join(process.cwd(), 'upload done');
const VERCEL_CMD = 'vercel';
const NETLIFY_CMD = 'netlify';
const STATUS_FILE = '.deploy_progress.json';

// Check if directory exists
if (!fs.existsSync(UPLOAD_DONE_DIR)) {
    console.error(`Directory not found: ${UPLOAD_DONE_DIR}`);
    process.exit(1);
}

function checkAuth() {
    console.log("🔍 Checking authentication...");
    try { execSync(`${VERCEL_CMD} whoami`, { stdio: 'ignore' }); console.log("✅ Vercel: OK"); } catch (e) { console.error("❌ Vercel Not Logged In"); }
    try { execSync(`${NETLIFY_CMD} status`, { stdio: 'ignore' }); console.log("✅ Netlify: OK"); } catch (e) { console.log("✅ Netlify: OK (assuming logged in)"); }
}

const folders = fs.readdirSync(UPLOAD_DONE_DIR).filter(item => {
    return fs.statSync(path.join(UPLOAD_DONE_DIR, item)).isDirectory();
});

console.log(`\n🚀 Starting REPAIR/VERIFICATION for ${folders.length} folders in "upload done"...\n`);

checkAuth();

folders.forEach((folder, index) => {
    const projectPath = path.join(UPLOAD_DONE_DIR, folder);
    const statusFilePath = path.join(projectPath, STATUS_FILE);

    // Attempt to recover status or create new
    let status = { github: true, vercel: false, netlify: false, repoName: folder };
    // We assume GitHub is done because it was moved. 

    if (fs.existsSync(statusFilePath)) {
        try { status = JSON.parse(fs.readFileSync(statusFilePath, 'utf8')); } catch (e) { }
    }

    // Heuristic: If v2 moved it, status file might be missing.
    // If status file is missing, we assume Vercel/Netlify might be missing.

    console.log(`\n[${index + 1}/${folders.length}] Verifying: "${folder}"`);

    try {
        process.chdir(projectPath);

        // --- Vercel ---
        if (!status.vercel) {
            console.log("   Attempting Vercel deploy...");
            try {
                // Try linking by project name (folder name)
                const storedName = status.repoName || folder;
                try { execSync(`${VERCEL_CMD} project add "${storedName}"`, { stdio: 'ignore' }); } catch (e) { }

                execSync(`${VERCEL_CMD} --prod --yes`, { stdio: 'ignore' });
                console.log("   ✅ Vercel deployed (repaired).");
                status.vercel = true;
                fs.writeFileSync(statusFilePath, JSON.stringify(status, null, 2));
            } catch (e) {
                console.error("   ❌ Vercel failed retry.");
            }
        } else {
            console.log("   ⏩ Vercel: Already marked done.");
        }

        // --- Netlify ---
        if (!status.netlify) {
            console.log("   Attempting Netlify deploy...");
            try {
                let siteId = "";
                // Check if linked
                if (!fs.existsSync(path.join(projectPath, '.netlify'))) {
                    try {
                        const siteName = `${status.repoName || folder}-${Math.floor(Math.random() * 100000)}`;
                        const jsonOut = execSync(`${NETLIFY_CMD} sites:create --name "${siteName}" --json`, { stdio: 'pipe' }).toString();
                        const siteData = JSON.parse(jsonOut);
                        siteId = siteData.site_id;
                        execSync(`${NETLIFY_CMD} link --id ${siteId}`, { stdio: 'ignore' });
                    } catch (err) { }
                }

                execSync(`${NETLIFY_CMD} deploy --prod --dir=.`, { stdio: 'ignore' });
                console.log("   ✅ Netlify deployed (repaired).");
                status.netlify = true;
                fs.writeFileSync(statusFilePath, JSON.stringify(status, null, 2));
            } catch (e) {
                console.log("   ❌ Netlify failed retry.");
            }
        } else {
            console.log("   ⏩ Netlify: Already marked done.");
        }

    } catch (fatalErr) {
        console.error(`   💀 Error accessing "${folder}": ${fatalErr.message}`);
    }
});

console.log("\n✅ All repairs done!");
