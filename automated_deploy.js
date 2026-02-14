const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const SOURCE_DIR = process.cwd();
const UPLOAD_DONE_DIR = path.join(SOURCE_DIR, 'upload done');
// We need to use 'gh' command, assuming it's in PATH or at the known location.
// PowerShell/CMD usually handles 'gh' if in PATH.
const GH_CMD = '"C:\\Program Files\\GitHub CLI\\gh.exe"';
const VERCEL_CMD = 'vercel';
const NETLIFY_CMD = 'netlify';

/**
 * Checks if a command exists/runs successfully.
 */
function checkLogin() {
    console.log("Checking authentication status...");

    // 1. GitHub
    try {
        execSync(`${GH_CMD} auth status`, { stdio: 'ignore' });
        console.log("✅ GitHub: Logged in");
    } catch (e) {
        console.log("❌ GitHub: Not logged in. Launching login...");
        try {
            // --web opens browser. 
            // We use stdio: 'inherit' so the user can see any prompts (like "Press Enter")
            execSync(`${GH_CMD} auth login --web -p https`, { stdio: 'inherit' });
        } catch (loginErr) {
            console.error("GitHub login failed. Please login manually using 'gh auth login'.");
            // proceed anyway? No, deployment will fail.
        }
    }

    // 2. Vercel
    try {
        execSync(`${VERCEL_CMD} whoami`, { stdio: 'ignore' });
        console.log("✅ Vercel: Logged in");
    } catch (e) {
        console.log("❌ Vercel: Not logged in. Launching login...");
        try {
            execSync(`${VERCEL_CMD} login`, { stdio: 'inherit' });
        } catch (loginErr) {
            console.error("Vercel login failed.");
        }
    }

    // 3. Netlify
    try {
        const status = execSync(`${NETLIFY_CMD} status`, { stdio: 'pipe' }).toString();
        if (status.includes("Not logged in")) {
            throw new Error("Not logged in");
        }
        console.log("✅ Netlify: Logged in");
    } catch (e) {
        console.log("❌ Netlify: Not logged in. Launching login...");
        try {
            execSync(`${NETLIFY_CMD} login`, { stdio: 'inherit' });
        } catch (loginErr) {
            console.error("Netlify login failed.");
        }
    }
}

// Ensure upload done directory exists
if (!fs.existsSync(UPLOAD_DONE_DIR)) {
    fs.mkdirSync(UPLOAD_DONE_DIR, { recursive: true });
}

// Get all directories (excluding system/hidden/done)
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
checkLogin();

console.log(`\nFound ${folders.length} folders to process.`);

// Process each folder
folders.forEach((folder, index) => {
    const projectPath = path.join(SOURCE_DIR, folder);

    // Sanitize project name for URLs/Repos
    let projectName = folder
        .toLowerCase()
        .replace(/\s+/g, '-')           // spaces to dashes
        .replace(/[^a-z0-9-]/g, '')     // remove special chars
        .replace(/-+/g, '-')            // collapse dashes
        .replace(/^-|-$/g, '');         // trim dashes

    if (!projectName) projectName = `project-${index}`;

    console.log(`\n---------------------------------------------------------`);
    console.log(`Processing [${index + 1}/${folders.length}]: "${folder}" as "${projectName}"`);
    console.log(`---------------------------------------------------------`);

    try {
        process.chdir(projectPath);

        // --- 1. Git Initialization ---
        if (!fs.existsSync(path.join(projectPath, '.git'))) {
            console.log('Initializing Git...');
            execSync('git init', { stdio: 'ignore' });
        }

        if (!fs.existsSync(path.join(projectPath, '.gitignore'))) {
            fs.writeFileSync('.gitignore', 'node_modules\n.env\n.DS_Store\ndist\nbuild\ncoverage\n');
        }

        try {
            execSync('git add .', { stdio: 'ignore' });
            execSync('git commit -m "Auto-deploy: Initial commit"', { stdio: 'ignore' });
        } catch (e) {
            // Nothing to commit is fine
        }

        // --- 2. GitHub Upload ---
        console.log('Creating/Pushing to GitHub...');
        try {
            // Create repo if not exists
            execSync(`${GH_CMD} repo create "${projectName}" --public --source=. --remote=origin --push`, { stdio: 'ignore' });
        } catch (e) {
            // If creation fails, try pushing to existing
            try {
                execSync('git push -u origin master', { stdio: 'ignore' });
            } catch (e2) {
                try {
                    execSync('git push -u origin main', { stdio: 'ignore' });
                } catch (e3) {
                    console.log('  (!) Git push failed.');
                }
            }
        }

        // --- 3. Vercel Deployment ---
        console.log('Deploying to Vercel...');
        try {
            // Link if needed (suppress output)
            try { execSync(`${VERCEL_CMD} project add "${projectName}"`, { stdio: 'ignore' }); } catch (e) { }
            // Deploy
            execSync(`${VERCEL_CMD} --prod --yes`, { stdio: 'ignore' });
        } catch (e) {
            console.error('  (!) Vercel deploy failed.');
        }

        // --- 4. Netlify Deployment ---
        console.log('Deploying to Netlify...');
        try {
            // Attempt create
            try {
                // If .netlify exists, assume linked
                if (!fs.existsSync(path.join(projectPath, '.netlify'))) {
                    const output = execSync(`${NETLIFY_CMD} sites:create --name "${projectName}-${Math.floor(Math.random() * 10000)}" --json`, { stdio: 'pipe' }).toString();
                    const siteId = JSON.parse(output).site_id;
                    execSync(`${NETLIFY_CMD} link --id ${siteId}`, { stdio: 'ignore' });
                }
            } catch (createErr) { }

            execSync(`${NETLIFY_CMD} deploy --prod --dir=.`, { stdio: 'ignore' });
        } catch (e) {
            console.error('  (!) Netlify deploy failed.');
        }

        // --- 5. Move to "Done" ---
        console.log(`Moving to done...`);
        process.chdir(SOURCE_DIR);
        try {
            const destPath = path.join(UPLOAD_DONE_DIR, folder);
            if (fs.existsSync(destPath)) {
                fs.renameSync(projectPath, path.join(UPLOAD_DONE_DIR, `${folder}_${Date.now()}`));
            } else {
                fs.renameSync(projectPath, destPath);
            }
        } catch (mvErr) {
            console.error('  (!) Move failed:', mvErr.message);
        }

    } catch (err) {
        console.error(`ERROR processing ${folder}:`, err.message);
        process.chdir(SOURCE_DIR);
    }
});
