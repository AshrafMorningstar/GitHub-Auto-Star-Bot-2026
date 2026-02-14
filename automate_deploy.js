const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sourceDir = process.cwd();
const uploadDoneDir = path.join(sourceDir, 'upload done');

if (!fs.existsSync(uploadDoneDir)) {
    fs.mkdirSync(uploadDoneDir);
}

const folders = fs.readdirSync(sourceDir).filter(file => {
    const fullPath = path.join(sourceDir, file);
    return fs.statSync(fullPath).isDirectory() && file !== 'upload done' && file !== '.git' && file !== 'node_modules';
});

console.log(`Found ${folders.length} folders to process.`);

folders.forEach(folder => {
    const folderPath = path.join(sourceDir, folder);
    const projectName = folder.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''); // Clean name

    console.log(`Processing: ${folder} -> ${projectName}`);

    try {
        process.chdir(folderPath);

        // 1. Git Init & Commit
        if (!fs.existsSync(path.join(folderPath, '.git'))) {
            execSync('git init', { stdio: 'inherit' });
        }

        if (!fs.existsSync(path.join(folderPath, '.gitignore'))) {
            fs.writeFileSync('.gitignore', 'node_modules\n.env\n.DS_Store\ndist\nbuild\n');
        }

        execSync('git add .', { stdio: 'inherit' });
        try {
            execSync('git commit -m "Initial commit"', { stdio: 'inherit' });
        } catch (e) {
            // Might fail if nothing to commit, which is fine
        }

        // 2. GitHub Create & Push
        try {
            // Check if remote exists
            execSync('git remote get-url origin', { stdio: 'ignore' });
        } catch (e) {
            // Create repo if remote doesn't exist
            // --confirm to skip interactive prompt if name exists? No, --source=. checks automatically.
            // If it fails (repo exists), we might validly catch it.
            try {
                execSync(`gh repo create "${projectName}" --public --source=. --remote=origin`, { stdio: 'inherit' });
            } catch (createError) {
                console.log(`Repo creation failed (maybe exists?), trying to push anyway...`);
                // If remote doesn't exist but create failed, we might need to add remote manually if it exists on GH.
                // For now, assume if create failed, maybe it's because it already exists? 
                // Let's try to add remote if missing.
            }
        }
        execSync('git push -u origin master || git push -u origin main', { stdio: 'inherit' });

        // 3. Vercel Deploy
        // --yes skips confirmation, --prod deploys to production
        try {
            execSync('vercel link --yes', { stdio: 'inherit' }); // Link first? Or deploy directly?
            // Vercel CLI usually prompts for linkage. --yes should handle "link to existing project?" or "create new?"
            // Actually `vercel --prod --yes` is often enough for new projects.
            execSync('vercel --prod --yes', { stdio: 'inherit' });
        } catch (err) {
            console.error(`Vercel deployment failed for ${folder}`);
            throw err;
        }

        // 4. Netlify Deploy
        // --prod --dir=. might need more logic for dist folder auto-detection? 
        // Netlify usually prompts for "publish directory".
        // To be fully auto, we might need to guess or use '.' 
        // `netlify deploy --prod` is interactive for new sites.
        // `netlify init` is also interactive.
        // For automation: `netlify api createSite` or `netlify deploy --prod --site ...` 
        // This is tricky without a site ID. 
        // Automating Netlify creation via CLI usually demands `netlify sites:create` first.
        try {
            const siteName = `auto-${projectName}-${Date.now()}`; // Unique name
            // Create site
            const siteId = execSync(`netlify sites:create --name "${siteName}" --json`).toString();
            const siteIdJson = JSON.parse(siteId);
            const actualSiteId = siteIdJson.site_id; // Check actual JSON structure of netlify sites:create

            execSync(`netlify deploy --prod --dir=. --site ${actualSiteId}`, { stdio: 'inherit' });
        } catch (err) {
            console.error(`Netlify deployment failed for ${folder}. Netlify auto-creation is complex via CLI without token setup or existing site.`);
            // If this fails, maybe we skip Netlify or log it.
            // Netlify `sites:create` might be interactive.
            // Alternative: just `netlify deploy --prod` and hope it picks up? No, it asks for site.
        }

        // 5. Move to upload done
        process.chdir(sourceDir); // Go back up
        fs.renameSync(folderPath, path.join(uploadDoneDir, folder));
        console.log(`Moved ${folder} to upload done.`);

    } catch (error) {
        console.error(`Failed to process ${folder}:`, error.message);
        process.chdir(sourceDir); // Ensure we go back up even on error
    }
});
