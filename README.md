# Energías

PWA para consultar de forma rápida precios de combustible en Gijón, el precio horario de la electricidad (PVPC) y la Tarifa de Último Recurso (TUR) de gas natural.

## Secciones
- Combustible: EasyGas Roces y estación más barata de Gijón por producto
- Luz: precio actual, próxima hora barata, top 3, listado horario y ranking de 24 horas
- Gas: TUR.1, TUR.2 y TUR.3 con término fijo y variable
- Instalable como PWA en móvil, tablet y ordenador

Los datos se sirven mediante una función serverless en `/api/dashboard`. Los precios de combustible y luz se cachean durante 5 minutos; la TUR de gas se actualiza cuando se publica un nuevo periodo oficial.
