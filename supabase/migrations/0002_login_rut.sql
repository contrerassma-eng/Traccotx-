-- Tracco Tx - RUT de login por contribuyente.
-- Para empresas que no tienen Portal MIPYME propio (p.ej. una EIRL nueva), la
-- sesión del SII se inicia con el RUT del representante (que sí tiene MIPYME) y
-- luego se selecciona la empresa. tx_contribuyentes.login_rut guarda ese RUT.
-- Si es null, se inicia sesión con el propio RUT del contribuyente.
alter table public.tx_contribuyentes add column if not exists login_rut text;

-- La EIRL 78236707-2 se opera como representante con la persona natural 10514666-3.
update public.tx_contribuyentes set login_rut = '10514666-3' where rut = '78236707-2';
