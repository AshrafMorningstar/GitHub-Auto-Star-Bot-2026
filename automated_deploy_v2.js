const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const SOURCE_DIR = process.cwd();
const UPLOAD_DONE_DIR = path.join(SOURCE_DIR, 'upload done');
const GH_CMD = '"C:\\Program Files\\GitHub CLI\\gh.exe"';
const VERCEL_CMD = 'vercel';
const NETLIFY_CMD = 'netlify';

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
                // Try to force garbage collection if possible (not really in JS)
                // Try to kill lingering git processes?
                try { execSync('taskkill /F /IM git.exe', { stdio: 'ignore' }); } catch (t) { }
            } else {
                throw e;
            }
        }
    }
    console.error(`   ❌ FAILED TO MOVE "${path.basename(src)}" after retries. Manual move required.`);
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
        // We will try to proceed, maybe token env var is set? But likely will fail.
    }

    // 2. Vercel
    try {
        execSync(`${VERCEL_CMD} whoami`, { stdio: 'ignore' });
        console.log("✅ Vercel: OK");
    } catch (e) {
        console.error("❌ Vercel: Not logged in. Please run `vercel login`.");
    }

    // 3. Netlify (Custom check because 'status' returns exit code 1 if not linked)
    try {
        // We expect this to throw often, so we catch and check output
        execSync(`${NETLIFY_CMD} status`, { stdio: 'pipe' });
        console.log("✅ Netlify: OK");
    } catch (e) {
        // Check if stdout contains user info despite error code
        const output = e.stdout ? e.stdout.toString() : (e.stderr ? e.stderr.toString() : "");
        if (output.includes("Current Netlify User") || output.includes("Email:")) {
            console.log("✅ Netlify: OK (Logged in, though not linked)");
        } else {
            console.error("❌ Netlify: Not logged in (or error checking). Proceeding might fail.");
            console.error("   Debug output:", output.substring(0, 100) + "...");
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
            // --source=. creates from current dir
            // --remote=origin sets the remote
            // --push pushes the commits
            // --public makes it public
            execSync(`${GH_CMD} repo create "${currentName}" --public --source=. --remote=origin --push`, { stdio: 'pipe' });
            console.log(`   ✅ GitHub repo created: ${currentName}`);
            created = true;
            return currentName;
        } catch (e) {
            const errOutput = e.stderr ? e.stderr.toString() : "";

            // Check for specific "Name already exists" error
            if (errOutput.includes("already exists") || errOutput.includes("name already exists")) {
                console.log(`   ⚠️ Name "${currentName}" is taken.`);
                // Generate new name
                const randomSuffix = Math.floor(Math.random() * 100000);
                currentName = `${projectName}-${randomSuffix}`;
                attempts++;
            }
            else if (errOutput.includes("remote origin already exists")) {
                console.log(`   ⚠️ Remote 'origin' exists. Assuming repo exists. Pushing...`);
                try {
                    execSync('git push -u origin master', { stdio: 'ignore' });
                } catch (pushErr) {
                    try { execSync('git push -u origin main', { stdio: 'ignore' }); } catch (p2) { }
                }
                created = true;
                return currentName; // Return current name (we didn't change it, just reused)
            }
            else {
                console.error(`   ❌ Failed to create repo "${currentName}". Error: ${errOutput.substring(0, 200)}...`);
                // If it's a different error, maybe we shouldn't retry endlessly.
                // But let's verify if we can just push?
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

// Run login checks first!
try {
    checkAuth();
} catch (e) {
    console.error("⚠️ Authentication check failed, but proceeding anyway:", e.message);
}

console.log(`\n🚀 Starting Bulk Processing for ${folders.length} folders...\n`);

folders.forEach((folder, index) => {
    const projectPath = path.join(SOURCE_DIR, folder);

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

    try {
        process.chdir(projectPath);

        // 1. Git Init
        if (!fs.existsSync(path.join(projectPath, '.git'))) {
            execSync('git init', { stdio: 'ignore' });
        }

        // Ensure .gitignore
        if (!fs.existsSync(path.join(projectPath, '.gitignore'))) {
            fs.writeFileSync('.gitignore', 'node_modules\n.env\n.DS_Store\ndist\nbuild\ncoverage\n');
        }

        // Commit
        try {
            execSync('git add .', { stdio: 'ignore' });
            execSync('git commit -m "Auto-deploy: Initial commit"', { stdio: 'ignore' });
        } catch (e) { /* No changes to commit */ }

        // 2. GitHub (Auto-Rename)
        const finalRepoName = createGitHubRepo(baseName, projectPath);

        // 3. Vercel
        console.log("   Deploying to Vercel...");
        try {
            // Link (ignore error if already linked or fails)
            try { execSync(`${VERCEL_CMD} project add "${finalRepoName}"`, { stdio: 'ignore' }); } catch (e) { }
            // Deploy
            execSync(`${VERCEL_CMD} --prod --yes`, { stdio: 'ignore' });
            console.log("   ✅ Vercel deployed.");
        } catch (e) {
            console.error("   ❌ Vercel failed.");
        }

        // 4. Netlify
        console.log("   Deploying to Netlify...");
        try {
            let siteId = "";
            // Try to create site if local config missing
            if (!fs.existsSync(path.join(projectPath, '.netlify'))) {
                try {
                    const siteName = `${finalRepoName}-${Math.floor(Math.random() * 100000)}`;
                    const jsonOut = execSync(`${NETLIFY_CMD} sites:create --name "${siteName}" --json`, { stdio: 'pipe' }).toString();
                    const siteData = JSON.parse(jsonOut);
                    siteId = siteData.site_id;
                    // Link
                    execSync(`${NETLIFY_CMD} link --id ${siteId}`, { stdio: 'ignore' });
                } catch (err) {
                    // Maybe site creation failed or limit reached? Try raw deploy.
                }
            }

            execSync(`${NETLIFY_CMD} deploy --prod --dir=.`, { stdio: 'ignore' });
            console.log("   ✅ Netlify deployed.");
        } catch (e) {
            console.log("   ❌ Netlify failed.");
        }

        // 5. Move to Done
        console.log(`   Moving to "upload done"...`);
        process.chdir(SOURCE_DIR); // Crucial: Move out of directory before renaming
        sleepSync(1000); // Give OS a second to release locks

        const dest = path.join(UPLOAD_DONE_DIR, folder);
        let finalDest = dest;
        if (fs.existsSync(dest)) {
            finalDest = path.join(UPLOAD_DONE_DIR, `${folder}_${Date.now()}`);
        }

        moveFolderWithRetry(projectPath, finalDest);

    } catch (fatalErr) {
        console.error(`   💀 CRITICAL ERROR on "${folder}": ${fatalErr.message}`);
        console.log("   ⚠️ Skipping move due to error to prevent data loss/loops.");
        process.chdir(SOURCE_DIR); // Reset cwd
    }
});

console.log("\n✅ All done!");
