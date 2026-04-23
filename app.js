function toggleDetails(btn){
  const row = btn.closest('tr');
  const next = row.nextElementSibling;
  next.classList.toggle('hidden');
}
