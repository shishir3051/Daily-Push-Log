const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { GoogleGenerativeAI } = require('@google/generative-ai');

const Project = require('./models/Project');
const PushLog = require('./models/PushLog');

async function getCommits(since = "midnight", until = "", projectIds = "all", requestedAuthor = "") {
  let repos;
  if (projectIds === 'all') {
    repos = await Project.find();
  } else {
    const idArray = projectIds.split(',');
    repos = await Project.find({ _id: { $in: idArray } });
  }
  if (!repos || repos.length === 0) {
    throw new Error('No projects found. Please add a project first.');
  }

  let globalAuthorEnv = process.env.GIT_AUTHOR_FILTER;
  let useAll = globalAuthorEnv && globalAuthorEnv.toLowerCase() === 'all';
  
  let results = [];
  let textSummary = '';

  for (const repo of repos) {
    try {
      let repoAuthorFilter = '';
      if (!useAll) {
        let author = requestedAuthor || globalAuthorEnv;
        if (!author) {
          try {
            // Use the currently logged-in OS username
            author = os.userInfo().username;
          } catch (err) {
            console.error(`Could not detect OS username`);
          }
        }
        if (author) {
          repoAuthorFilter = `--author="${author}"`;
        }
      }

      let sinceStr = since;
      if (since && since.match(/^\d{4}-\d{2}-\d{2}$/)) {
        sinceStr = `${since} 00:00:00`;
      }
      let untilParam = '';
      if (until) {
        let untilStr = until;
        if (until.match(/^\d{4}-\d{2}-\d{2}$/)) {
          untilStr = `${until} 23:59:59`;
        }
        untilParam = `--until="${untilStr}"`;
      }
      
      // Added "--name-status" and a specific delimiter "|||COMMIT|||" to parse multi-line output
      const command = `git log --all --since="${sinceStr}" ${untilParam} ${repoAuthorFilter} --name-status --pretty=format:"|||COMMIT|||%h|%ad|%s" --date=format:"%Y-%m-%d %H:%M" -- .`;
      
      const { stdout } = await execPromise(command, { cwd: repo.path });
      
      if (stdout.trim()) {
        const commitBlocks = stdout.trim().split('|||COMMIT|||').filter(Boolean);
        const commits = commitBlocks.map(block => {
          const lines = block.trim().split('\n').filter(Boolean);
          const [hash, time, ...messageParts] = lines[0].split('|');
          const message = messageParts.join('|');
          const files = lines.slice(1).map(l => l.trim());
          
          return {
            hash,
            time,
            message,
            files
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
    repo.commits.forEach(c => {
      finalSummary += `- Hash: ${c.hash}\n  Date: ${c.time}\n  Message: ${c.message}\n`;
      if (c.files && c.files.length > 0) {
        const fileLimit = 15;
        const filesToShow = c.files.slice(0, fileLimit);
        finalSummary += `  Files Changed:\n    ${filesToShow.join('\n    ')}\n`;
        if (c.files.length > fileLimit) {
          finalSummary += `    ... and ${c.files.length - fileLimit} more files\n`;
        }
      }
    });
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
      const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-flash-latest' });
      const prompt = `You are an AI assistant helping a developer format their daily standup report. Here are all the raw git commits they made recently, including timestamps and the specific files they modified:\n${finalSummary}\n\nRegardless of how many individual commits there are, please summarize the work into exactly **two professional tasks PER DAY** that there were commits. YOU MUST NOT SKIP ANY DAYS. If a day has commits, you MUST include it.\n\nCRITICAL INSTRUCTION ON TONE AND ACCURACY: \nTransform the raw commits into professional, readable task descriptions (e.g., remove git commit prefixes like "fix:", "feat:", etc). You must accurately reflect the actual work done based on BOTH the commit message and the "Files Changed". If the commit message is vague, look at the files they modified to infer what feature they worked on. Retain the core technical entities and feature names so the original meaning is preserved, but format them nicely as professional sentences.\n\nCRITICAL INSTRUCTION ON CLIENT TAGS (VERY IMPORTANT): \n1. You must read the commit messages. If a commit message explicitly mentions a client (e.g., "dbl", "bank asia", "nbl", "dhaka bank"), you MUST prefix the generated task with that client's name in brackets, e.g., [DBL] or [Bank Asia].\n2. If the commit message does NOT mention any specific client, do NOT invent one. Just generate the task without ANY bracket tag. DO NOT output tags like [Untagged] or [Project].\n\nFormat your output strictly grouped by date like this:\n**YYYY-MM-DD**\n* [Client A] Task 1\n* Task 2 (if no client mentioned)\n\nOutput ONLY this plain text list.`;
      
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
