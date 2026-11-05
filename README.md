# Handwriting → Font

Turn photos (or a webcam snapshot) of your handwriting into an installable `.otf` font. It runs entirely in your browser; nothing is uploaded anywhere.

**Live demo:** https://gabeelezaj.github.io/photos-to-font/

## Run it

```sh
./start.sh
```

That serves the folder at http://localhost:8765 and opens it. (The webcam only works on `localhost` or `https`, which is why there's a tiny server. Photos also work if you just open `index.html` directly.)

## How to use it

1. **Write.** Print letters separately (not joined-up cursive) with a dark pen on plain, unlined paper. Good things to write (the app suggests them too):
   - `the quick brown fox jumps over the lazy dog`
   - `THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG`
   - `12345 67890`
   - `. , ! ? ' " - : ; ( ) & @ # $ % / + = *`
2. **Add it.** Drop in photos, paste an image, or click **Use webcam**, hold the page up and **Capture**. Green boxes in the live view show the letters the camera can make out.
3. **Type what you wrote** under each photo. The app splits the writing into words and letters and labels each one from your text. Green means matched, amber means it had to guess (merge or split pieces), so check those.
4. **Fix anything wrong** in *Check the letters*: retype a label, or select tiles and Merge / Split / Delete. Drag on a photo to crop out clutter; use the sliders if ink is missed or specks are picked up.
5. **Pick and preview.** If you wrote a letter more than once, click it in *Your alphabet* to choose which version to use. Adjust weight and spacing, type in the preview box, then **Download font (.otf)** and double-click the file to install it.

## How it works

- `js/imageproc.js`: adaptive thresholding (copes with shadows and uneven light), removing the background around the page, and connected-component labelling.
- `js/segment.js`: joins dots and accents to their letters, groups letters into lines (even when the page is slightly tilted) and words, and aligns them with your typed text. It also finds each line's baseline and x-height so every letter sits and scales consistently.
- `js/trace.js`: upsamples, smooths and traces each letter into vector outlines.
- `js/fontbuild.js`: turns the outlines into smooth curves and writes the OpenType font with [opentype.js](https://opentype.js.org) (vendored in `js/vendor`).
