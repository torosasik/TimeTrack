// Generate initials from name
export function getInitials(name: string): string {
  const parts = name.trim().split(' ');
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

// Generate consistent color based on name
export function getAvatarColor(name: string): string {
  const colors = [
    'bg-blue-500',
    'bg-green-500',
    'bg-purple-500',
    'bg-orange-500',
    'bg-pink-500',
    'bg-teal-500',
    'bg-indigo-500',
    'bg-cyan-500',
    'bg-emerald-500',
    'bg-amber-500',
  ];

  // Generate consistent index based on name
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  
  return colors[index];
}

// Get avatar background and text color classes
export function getAvatarClasses(name: string): { bg: string; text: string } {
  const bgColor = getAvatarColor(name);
  return {
    bg: bgColor,
    text: 'text-white',
  };
}
