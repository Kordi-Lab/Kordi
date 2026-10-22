// Card look pieces shared by the card, the look popover and New card: the icons a card can
// pick, and the popover's open state.

import { useCallback, useState } from 'react';
import {
  Book, Briefcase, Calendar, Camera, Code, Coffee, FlaskConical, Globe, GraduationCap, Heart, Leaf, MapPin, MessageCircle, Microscope, Music,
  Rocket, Star, Sun, type LucideIcon,
} from 'lucide-react';

import type { CgCardIcon } from './types';

/** The icons a card can pick, by the name the server keeps. */
export const CARD_ICONS: Record<CgCardIcon, LucideIcon> = {
  briefcase: Briefcase, leaf: Leaf, sun: Sun, flask: FlaskConical, book: Book, microscope: Microscope,
  graduation: GraduationCap, pin: MapPin, star: Star, heart: Heart, chat: MessageCircle, globe: Globe,
  music: Music, camera: Camera, code: Code, calendar: Calendar, rocket: Rocket, coffee: Coffee,
};

/** Open state for one look popover. */
export function useLookPopover() {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const close = useCallback(() => setOpen(false), []);
  return { open, toggle, close };
}
