# Sakinah website — how it's hosted and how to update it

## What's online right now

| Thing | Where |
|---|---|
| Website | **https://vermillion-pony-89c61c.netlify.app** (Netlify, free) |
| Installer 1.1.0 | **https://vermillion-pony-89c61c.netlify.app/download/Sakinah-Setup-1.1.0.exe** (91 MB, inside the same site) |
| Site name | `sakinah` · account `sajadstudy2010` |

The website files live in `C:\Users\ADMIN_sajad\Sakinah\site\` — this folder is what's deployed.
The Download button already points at `/download/Sakinah-Setup-1.1.0.exe` via `site\config.js`.

## Updating the website (one command)

Edit anything in the `site` folder (text, images, config.js…), then:

```powershell
netlify.cmd deploy --dir "C:\Users\ADMIN_sajad\Sakinah\site" --site "e9d777c9-0709-4a79-8c2f-ba96867dc6d1" --prod --message "site update"
```

The URL stays exactly the same. If you publish a new app version:

1. Build it (`npm.cmd run dist` in `C:\Users\ADMIN_sajad\Sakinah`)
2. Copy the new installer over the old one:
   ```powershell
   Copy-Item "C:\Users\ADMIN_sajad\Sakinah\dist\Sakinah Setup <NEW>.exe" "C:\Users\ADMIN_sajad\Sakinah\site\download\Sakinah-Setup-<NEW>.exe" -Force
   ```
3. Point `site\config.js`'s `DOWNLOAD_URL` and the version text in `site\index.html` to the new version
4. Re-run the deploy command above

Login already lives on this PC (`netlify login` was done once). If it ever expires: run `netlify.cmd login` and click Login in the browser that opens.

## Want a prettier web address?

Open your site: https://app.netlify.com/projects/vermillion-pony-89c61c
→ **Site configuration → Change site name** → pick e.g. `sakinah-download` (if the name is free, the address becomes `sakinah-download.netlify.app`). Do it once; the config.js link doesn't break.

## Optional upgrade: GitHub Releases mirror

If you ever want the installer mirrored outside Netlify (independence + version history), create a GitHub account, make a repo, and drag `dist\Sakinah-Setup-1.1.0.exe` into a Release `v1.1.0`. Then set `DOWNLOAD_URL` in `site\config.js` to that file's link and re-deploy — the website's button then uses GitHub instead. Not required; current hosting is fine and free.
