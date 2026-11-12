/**
 * The residents. Who they are is NOT here: each one's role and story is
 * written in plain English on its character in the White Sands web app, and
 * the platform plays it. The game only knows which character ID to play,
 * where it wakes up, and what it looks like.
 */
export type Look = { skin: string; shirt: string; hair: string };

export const cast: { id: string; name: string; home: string; startsAt: string; look: Look }[] = [
  { id: "5a4d7000-0000-4000-8000-0000000000b1", name: "Mia", home: "mia_cottage", startsAt: "cafe", look: { skin: "#d6a078", shirt: "#f0785a", hair: "#5a3220" } },
  { id: "5a4d7000-0000-4000-8000-0000000000b2", name: "Finn", home: "finn_cottage", startsAt: "pier", look: { skin: "#e6bea0", shirt: "#3c5a6e", hair: "#d8d8d8" } },
  { id: "5a4d7000-0000-4000-8000-0000000000b3", name: "Ruby", home: "ruby_cottage", startsAt: "general_store", look: { skin: "#78503c", shirt: "#c83c78", hair: "#201410" } },
  { id: "5a4d7000-0000-4000-8000-0000000000b4", name: "Leo", home: "leo_cottage", startsAt: "park", look: { skin: "#f0cdaa", shirt: "#6ea078", hair: "#2a2a30" } },
  { id: "5a4d7000-0000-4000-8000-0000000000b5", name: "Juno", home: "juno_cottage", startsAt: "plaza", look: { skin: "#be8c64", shirt: "#965ae6", hair: "#f0c040" } },
];
