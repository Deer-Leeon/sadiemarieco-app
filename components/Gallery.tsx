'use client';

/**
 * Portfolio & Gallery — micro-collage on mobile (all five tiles on one
 * screen) + restored 2/3-column desktop grid, with a full-screen lightbox.
 */
import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { GALLERY_IMAGES, type GalleryImage } from '@/lib/gallery-images';
import { cn } from '@/lib/utils';

function GalleryTile({
  image,
  index,
  onSelect,
}: {
  image: GalleryImage;
  index: number;
  onSelect: (src: string) => void;
}) {
  return (
    <figure
      className={cn(
        'group relative overflow-hidden rounded-lg shadow-md transition-transform duration-300 hover:scale-[1.02] md:shadow-sm',
        'max-md:w-[65%] md:w-full md:self-auto',
        index % 2 === 0 ? 'max-md:self-start' : 'max-md:self-end'
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        data-image-id={image.id}
        src={image.src}
        alt={image.alt}
        loading="lazy"
        decoding="async"
        onClick={() => onSelect(image.src)}
        className="aspect-[16/9] w-full cursor-zoom-in object-cover saturate-[0.88]"
      />
      <span
        data-caption-id={image.id}
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#0d1b2a]/85 to-transparent px-4 pb-3 pt-8 font-sans text-[0.58rem] font-light uppercase tracking-[0.22em] text-[#f5f3f0]/80 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 translate-y-1.5"
      >
        {image.caption}
      </span>
    </figure>
  );
}

function GalleryLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Gallery image preview"
      className="fixed inset-0 z-[100] flex cursor-zoom-out items-center justify-center bg-black/95 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close gallery preview"
        className="absolute top-6 right-6 z-[110] p-2 text-white/80 transition-colors hover:text-white"
      >
        <X className="h-7 w-7" strokeWidth={1.5} aria-hidden />
      </button>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-full rounded-md object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

export default function Gallery() {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  const closeLightbox = useCallback(() => setSelectedImage(null), []);

  return (
    <>
      <div
        className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-4 lg:grid-cols-3 lg:gap-5"
        aria-label="Portfolio gallery"
      >
        {GALLERY_IMAGES.map((image, index) => (
          <GalleryTile
            key={image.id}
            image={image}
            index={index}
            onSelect={setSelectedImage}
          />
        ))}
      </div>

      {selectedImage !== null && (
        <GalleryLightbox
          src={selectedImage}
          alt={
            GALLERY_IMAGES.find((img) => img.src === selectedImage)?.alt ?? ''
          }
          onClose={closeLightbox}
        />
      )}
    </>
  );
}

/** Re-export for pages that need the raw image list. */
export { GALLERY_IMAGES };
