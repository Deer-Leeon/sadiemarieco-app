/**
 * Portfolio gallery slots — same URLs and captions as `public/index.html`.
 * CMS uploads in /admin/website override `src` at render time via
 * `data-image-id` substitution in `app/route.ts`.
 */
export interface GalleryImage {
  id: string;
  src: string;
  alt: string;
  caption: string;
}

export const GALLERY_IMAGES: readonly GalleryImage[] = [
  {
    id: 'portfolio_1',
    src: 'assets/images/addy1.jpeg',
    alt: 'Lash extensions',
    caption: 'Classic Lashes',
  },
  {
    id: 'portfolio_2',
    src: 'https://images.unsplash.com/photo-1560869713-7d0a29430803?w=900&q=85&fit=crop',
    alt: 'Skincare glow',
    caption: 'Glow Facial',
  },
  {
    id: 'portfolio_3',
    src: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=500&q=85&fit=crop',
    alt: 'Brow lamination',
    caption: 'Brow Lamination',
  },
  {
    id: 'portfolio_4',
    src: 'https://images.unsplash.com/photo-1487412947147-5cebf100ffc2?w=500&q=85&fit=crop&crop=face',
    alt: 'Volume lashes',
    caption: 'Volume Set',
  },
  {
    id: 'portfolio_5',
    src: 'https://images.unsplash.com/photo-1616394584738-fc6e612e71b9?w=500&q=85&fit=crop',
    alt: 'Skincare treatment',
    caption: 'Skin Treatment',
  },
] as const;
