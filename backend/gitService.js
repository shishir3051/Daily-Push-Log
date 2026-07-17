const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { GoogleGenerativeAI } = require('@google/generative-ai');

const Project = require('./models/Project');
const PushLog = require('./models/PushLog');

async function getCommits(since = "midnight") {
  const repos = await Project.find();
  if (!repos || repos.length === 0) {
    throw new Error('No projects found. Please add a project first.');
  }

  let author = process.env.GIT_AUTHOR_FILTER || '';
  if (!author) {
    try {
      const { stdout } = await execPromise('git config --global user.name');
      author = stdout.trim();
    } catch (err) {
      console.error('Could not detect git user.name');
    }
  }
  let authorFilter = author ? `--author="${author}"` : '';
  
  let results = [];
  let textSummary = '';

  for (const repo of repos) {
    try {
      const command = `git log --all --since="${since}" ${authorFilter} --pretty=format:"%h|%ad|%s" --date=format:"%Y-%m-%d %H:%M"`;
      
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

      }
    } catch (err) {
      console.error(`Error processing repo ${repo.name} at ${repo.path}:`, err.message);
    }
  }

  let finalSummary = '';
  results.forEach(repo => {
    finalSummary += `\n[${repo.project}]\n${repo.commits.map(c => `- ${c.hash} (${c.time}) ${c.message}`).join('\n')}\n`;
  });

  const currentHashes = results.flatMap(r => r.commits.map(c => c.hash)).join(',');
  const existingLog = await PushLog.findOne().sort({ createdAt: -1 });
  const existingHashes = existingLog ? existingLog.summary.flatMap(r => r.commits.map(c => c.hash)).join(',') : '';

  if (currentHashes === existingHashes && currentHashes !== '') {
    return {
      ok: true,
      summary: results,
      text: existingLog.text,
      fromCache: true
    };
  }

  if (finalSummary && process.env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const prompt = `You are an AI assistant helping a developer format their daily standup report. Here are all the raw git commits they made recently, including timestamps:\n${finalSummary}\n\nRegardless of how many individual commits there are, please summarize the work into exactly **two high-level, professional tasks PER DAY** that there were commits. Focus on overall business value and remove minor commit noise.\n\nFormat your output strictly grouped by date like this:\n**YYYY-MM-DD**\n* Task 1\n* Task 2\n\nOutput ONLY this plain text list. Do not include days with zero commits.`;
      
      const result = await model.generateContent(prompt);
      finalSummary = result.response.text().trim();
    } catch (err) {
      console.error('Gemini AI Error:', err.message);
    }
  }

  return {
    ok: true,
    summary: results,
    text: finalSummary
  };
}

module.exports = {
  getCommits
};
