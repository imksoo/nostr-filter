export const extractHashtags = (tags: string[][]): string[] => {
  return tags.filter((tag) => tag[0] === "t").map((tag) => tag[1]);
};

export const isActivityPubUser = (tags: string[][]): boolean => {
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index];
    if (tag.length === 3 && tag[0] === "proxy" && tag[2] === "activitypub") {
      return true;;
    }
  }
  return false;
};

export const isRootPost = (tags: string[][]): boolean => {
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index];
    if (tag[0] === "e") {
      return false;
    }
  }
  return true;
};

export const hasContentWarning = (tags: string[][]): boolean => {
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index];
    if (tag[0] === "content-warning") {
      return true;
    }
  }
  return false;
};

export const hasNsfwHashtag = (hashtags: string[]): boolean => {
  for (let index = 0; index < hashtags.length; index++) {
    const tag = hashtags[index].toLowerCase();
    if (tag === "nsfw") {
      return true;
    }
  }
  return false;
};
