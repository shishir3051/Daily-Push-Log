const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function getCommitsForToday() {
  const reposPath = path.join(__dirname, 'repos.json');
  let repos = [];
  try {
    repos = JSON.parse(fs.readFileSync(reposPath, 'utf8'));
  } catch (err) {
    throw new Error('Could not read repos.json. Ensure it exists and contains a valid JSON array.');
  }

  const author = process.env.GIT_AUTHOR_FILTER || '';
  let authorFilter = author ? `--author="${author}"` : '';
  
  let results = [];
  let textSummary = '';

  for (const repo of repos) {
    try {
      const command = `git log --all --since="midnight" ${authorFilter} --pretty=format:"%h|%ad|%s" --date=format:"%H:%M"`;
      
      const { stdout } = await execPromise(command, { cwd: repo.path });
      
      if (stdout.trim()) {
        const commits = stdout.trim().split('\n').map(line => {
          const [hash, time, ...messageParts] = line.split('|');
          return {
            hash,
            time,
            message: messageParts.join('|')
          };
        });
        
        results.push({
          project: repo.name,
          commits
        });

        textSummary += `\n[${repo.name}]\n`;
        commits.forEach(c => {
          textSummary += `- ${c.hash} (${c.time}) ${c.message}\n`;
        });
      }
    } catch (err) {
      console.error(`Error processing repo ${repo.name} at ${repo.path}:`, err.message);
    }
  }

  return {
    ok: true,
    summary: results,
    text: textSummary.trim()
  };
}

module.exports = {
  getCommitsForToday
};
