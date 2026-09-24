SPOREDESK BRAND KIT
===================

Start with 04-Print/SporeDesk-Brand-Guide.pdf. It covers colors, fonts, and how to use the logo.

"for-light-backgrounds" = dark type, use on cream/white.
"for-dark-backgrounds"  = cream type, use on dark/ink.
All logo PNGs have transparent backgrounds.


01-Logo
-------
Master-Artwork/   The full plate artwork. 4096/2048/1024/512 px PNGs.
                  sporedesk-plate-master.svg is the source vector. It's 8 MB and uses
                  blur and texture filters that some programs (like Illustrator)
                  don't render correctly, so use the PNGs day to day.
Lockups/          Plate + name + tagline. Horizontal (default) and stacked.
Wordmark/         Name only, with and without tagline. SVGs are true vector
                  (text converted to shapes), so they scale to any size.
Tiny-Size-Mark/   A flat simplified plate, ONLY for 16-48 px (favicons, tiny UI).
                  Don't use it any bigger; use the master artwork instead.

02-App-and-Web-Icons
--------------------
iOS/AppIcon-1024.png                 App Store / Xcode icon (no transparency, square).
Android/                             Play Store icon + adaptive icon foreground/background.
PWA/                                 icon-192, icon-512, icon-maskable-512 for the home-screen app.
Website/                             favicon.ico, favicon.svg, favicon-16/32/48.png,
                                     apple-touch-icon.png, og-image-1200x630.png (link previews),
                                     header logos, site.webmanifest, head-snippet.html.
                                     Copy these files into the site's or app's public/ folder
                                     and paste head-snippet.html into <head>.
Windows-Desktop-App/icon.ico         Multi-size icon for the Electron build (16-256 px).
                                     icon-512.png for electron-builder if it asks for a PNG.

03-Social-Media
---------------
profile-picture-1080.png             Works as a circle crop on every platform.
facebook-cover-1640x624.png
x-twitter-header-1500x500.png
linkedin-banner-1584x396.png
youtube-banner-2560x1440.png         Name and tagline sit in the center area that shows on phones and TVs; the plate gets cropped on smaller screens.
post-square-1080x1080.png / post-portrait-1080x1350.png   General brand posts.

04-Print
--------
Business-Card/    3.5 x 2 in, two-sided. The PDF is print-ready with 0.125 in bleed
                  on every side (3.75 x 2.25 in total), fonts embedded.
                  Upload the PDF to your printer, and tell them it includes bleed.
Stickers/         3 in round sticker and 3 x 2 in label, both with 0.125 in bleed.
                  Order the round one as a circle die-cut.
SporeDesk-Brand-Guide.pdf

Colors
------
Ink        #241811   Reishi   #6b2717   Amber     #d6934a
Parchment  #ede3d0   Paper    #f6f1e7

Fonts (free, Google Fonts, SIL Open Font License)
-----
Libre Caslon Display  - wordmark and large headlines
IBM Plex Mono         - tagline, labels, small text
