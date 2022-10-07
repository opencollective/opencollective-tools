module.exports = {
  formatUserName: (user) => {
    const handle = user.profile.display_name_normalized || user.name;
    return `@${handle} (${user.real_name} #${user.id})`;
  },
};
