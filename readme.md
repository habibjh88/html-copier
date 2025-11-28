Got it — you want ONE single code block that includes the entire README, with no nested backticks breaking it.
Here you go — copy & paste as-is:

# Static Site Downloader

A simple Puppeteer script that downloads a live website as a fully offline static copy.  
It saves rendered HTML pages and downloads images, CSS, JS, fonts, and other assets.

## Install
    npm install

## Run
    node save-rendered.js

## Output
All files will be saved into:
    rendered-site/

## Configure
Edit these values inside the script:
    const START_URL = "https://themenectar.com/salient/signal/";
    const PATH_PREFIX = "/salient/";
    const MAX_PAGES = 500;