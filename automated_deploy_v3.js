const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const SOURCE_DIR = process.cwd();
const UPLOAD_DONE_DIR = path.join(SOURCE_DIR, 'upload done');
const GH_CMD = '"C:\\Program Files\\GitHub CLI\\gh.exe"';
const VERCEL_CMD = 'vercel';
const NETLIFY_CMD = 'netlify';
const STATUS_FILE = '.deploy_progress.json';

// Ensure upload done directory exists
if (!fs.existsSync(UPLOAD_DONE_DIR)) {
    fs.mkdirSync(UPLOAD_DONE_DIR, { recursive: true });
}

function sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { }
}

function moveFolderWithRetry(src, dest) {
    try { process.chdir(SOURCE_DIR); } catch (e) { } // Ensure we are out

    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
        try {
            fs.renameSync(src, dest);
            console.log(`   ✅ Moved to "upload done".`);
            return;
        } catch (e) {
            if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
                console.log(`   ⏳ Folder locked (${e.code}), retrying in 3s... (${attempts + 1}/${maxAttempts})`);
                sleepSync(3000);
                attempts++;
                try { execSync('taskkill /F /IM git.exe', { stdio: 'ignore' }); } catch (t) { }
            } else {
                throw e; // Rethrow other errors
            }
        }
    }
    console.error(`   ❌ FAILED TO MOVE "${path.basename(src)}" after retries.`);
}

/**
 * Robust check for login status
 */
function checkAuth() {
    console.log("🔍 Checking authentication...");

    // 1. GitHub
    try {
        execSync(`${GH_CMD} auth status`, { stdio: 'ignore' });
        console.log("✅ GitHub: OK");
    } catch (e) {
        console.error("❌ GitHub: Not logged in. Please run `gh auth login` first.");
    }

    // 2. Vercel
    try {
        execSync(`${VERCEL_CMD} whoami`, { stdio: 'ignore' });
        console.log("✅ Vercel: OK");
    } catch (e) {
        console.error("❌ Vercel: Not logged in. Please run `vercel login`.");
    }

    // 3. Netlify
    try {
        execSync(`${NETLIFY_CMD} status`, { stdio: 'pipe' });
        console.log("✅ Netlify: OK");
    } catch (e) {
        const output = e.stdout ? e.stdout.toString() : (e.stderr ? e.stderr.toString() : "");
        if (output.includes("Current Netlify User") || output.includes("Email:")) {
            console.log("✅ Netlify: OK (Logged in, though not linked)");
        } else {
            console.error("❌ Netlify: Not logged in (or error checking).");
        }
    }
}

/**
 * Creates a GitHub repo, retrying with a new name if it already exists.
 */
function createGitHubRepo(projectName, projectPath) {
    let currentName = projectName;
    let attempts = 0;
    const maxAttempts = 5;
    let created = false;

    while (!created && attempts < maxAttempts) {
        console.log(`   Attempting GitHub repo create: "${currentName}"...`);
        try {
            execSync(`${GH_CMD} repo create "${currentName}" --public --source=. --remote=origin --push`, { stdio: 'pipe' });
            console.log(`   ✅ GitHub repo created: ${currentName}`);
            created = true;
            return currentName;
        } catch (e) {
            const errOutput = e.stderr ? e.stderr.toString() : "";

            if (errOutput.includes("already exists") || errOutput.includes("name already exists")) {
                console.log(`   ⚠️ Name "${currentName}" is taken.`);
                const randomSuffix = Math.floor(Math.random() * 100000);
                currentName = `${projectName}-${randomSuffix}`;
                attempts++;
            }
            else if (errOutput.includes("remote origin already exists")) {
                console.log(`   ⚠️ Remote 'origin' exists. Pushing...`);
                try {
                    execSync('git push -u origin master', { stdio: 'ignore' });
                } catch (pushErr) {
                    try { execSync('git push -u origin main', { stdio: 'ignore' }); } catch (p2) { }
                }
                created = true;
                return currentName;
            }
            else {
                console.error(`   ❌ Failed to create repo "${currentName}". Error: ${errOutput.substring(0, 200)}...`);
                break;
            }
        }
    }
    return currentName;
}

// === MAIN LOOP ===

const allItems = fs.readdirSync(SOURCE_DIR);
const folders = allItems.filter(item => {
    const fullPath = path.join(SOURCE_DIR, item);
    return fs.statSync(fullPath).isDirectory() &&
        item !== 'upload done' &&
        item !== '.git' &&
        item !== 'node_modules' &&
        !item.startsWith('.');
});

try {
    checkAuth();
} catch (e) {
    console.error("⚠️ Authentication check failed, but proceeding anyway:", e.message);
}

console.log(`\n🚀 Starting Bulk Processing for ${folders.length} folders...\n`);

folders.forEach((folder, index) => {
    const projectPath = path.join(SOURCE_DIR, folder);
    const statusFilePath = path.join(projectPath, STATUS_FILE);

    // Read status file
    let status = { github: false, vercel: false, netlify: false, repoName: null };
    if (fs.existsSync(statusFilePath)) {
        try {
            status = JSON.parse(fs.readFileSync(statusFilePath, 'utf8'));
        } catch (e) { }
    }

    // Clean name
    let baseName = folder
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    if (!baseName) baseName = `project-${index}`;

    console.log(`\n[${index + 1}/${folders.length}] Processing: "${folder}"`);
    console.log(`-----------------------------------------------`);
    console.log(`   Status: GitHub=${status.github}, Vercel=${status.vercel}, Netlify=${status.netlify}`);

    try {
        process.chdir(projectPath);

        // 1. Git Init (Always ensure git is ready)
        if (!fs.existsSync(path.join(projectPath, '.git'))) execSync('git init', { stdio: 'ignore' });
        if (!fs.existsSync(path.join(projectPath, '.gitignore'))) fs.writeFileSync('.gitignore', 'node_modules\n.env\n.DS_Store\ndist\nbuild\ncoverage\n.deploy_progress.json\n');
        try { execSync('git add .', { stdio: 'ignore' }); execSync('git commit -m "Auto-deploy: Initial commit"', { stdio: 'ignore' }); } catch (e) { }

        // 2. GitHub
        if (!status.github) {
            const finalRepoName = createGitHubRepo(status.repoName || baseName, projectPath);
            if (finalRepoName) {
                status.github = true;
                status.repoName = finalRepoName;
                fs.writeFileSync(statusFilePath, JSON.stringify(status, null, 2));
            }
        } else {
            console.log("   ⏩ GitHub: Already done.");
        }

        // 3. Vercel
        if (!status.vercel) {
            console.log("   Deploying to Vercel...");
            try {
                try { execSync(`${VERCEL_CMD} project add "${status.repoName || baseName}"`, { stdio: 'ignore' }); } catch (e) { }
                execSync(`${VERCEL_CMD} --prod --yes`, { stdio: 'ignore' });
                console.log("   ✅ Vercel deployed.");
                status.vercel = true;
                fs.writeFileSync(statusFilePath, JSON.stringify(status, null, 2));
            } catch (e) {
                console.error("   ❌ Vercel failed.");
            }
        } else {
            console.log("   ⏩ Vercel: Already done.");
        }

        // 4. Netlify
        if (!status.netlify) {
            console.log("   Deploying to Netlify...");
            try {
                let siteId = "";
                if (!fs.existsSync(path.join(projectPath, '.netlify'))) {
                    try {
                        const siteName = `${status.repoName || baseName}-${Math.floor(Math.random() * 100000)}`;
                        const jsonOut = execSync(`${NETLIFY_CMD} sites:create --name "${siteName}" --json`, { stdio: 'pipe' }).toString();
                        const siteData = JSON.parse(jsonOut);
                        siteId = siteData.site_id;
                        execSync(`${NETLIFY_CMD} link --id ${siteId}`, { stdio: 'ignore' });
                    } catch (err) { }
                }
                execSync(`${NETLIFY_CMD} deploy --prod --dir=.`, { stdio: 'ignore' });
                console.log("   ✅ Netlify deployed.");
                status.netlify = true;
                fs.writeFileSync(statusFilePath, JSON.stringify(status, null, 2));
            } catch (e) {
                console.log("   ❌ Netlify failed.");
            }
        } else {
            console.log("   ⏩ Netlify: Already done.");
        }

        // 5. Move to Done
        if (status.github && status.vercel && status.netlify) {
            console.log(`   Moving to "upload done"...`);
            // Clean up status file before moving? Or keep it? keeping it is safer.
            // Move out FIRST
            process.chdir(SOURCE_DIR);
            sleepSync(1000);

            const dest = path.join(UPLOAD_DONE_DIR, folder);
            let finalDest = dest;
            if (fs.existsSync(dest)) {
                finalDest = path.join(UPLOAD_DONE_DIR, `${folder}_${Date.now()}`);
            }

            moveFolderWithRetry(projectPath, finalDest);
        } else {
            console.log(`   ⚠️ Not all steps complete. Keeping folder for retry.`);
        }

    } catch (fatalErr) {
        console.error(`   💀 CRITICAL ERROR on "${folder}": ${fatalErr.message}`);
        console.log("   ⚠️ Skipping move due to error.");
        process.chdir(SOURCE_DIR);
    }
});

console.log("\n✅ All done!");
